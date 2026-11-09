// Prueba de humo contra Supabase real (staging), por REST, igual que lo hace el front.
//   ML_ANON_KEY=... ML_ADMIN_KEY=... node scripts/smoke.mjs        (ML_SUPABASE_URL opcional)
//
// OJO: staging es la base REAL. Las reservas de prueba usan el prefijo reservado `zz.smoke.`, caen en el ULTIMO
// cupo del dia mas lejano y se borran al final (tambien si el smoke falla a medias) con ml_admin_purge_test, que
// necesita ML_ADMIN_KEY. Sin ML_ADMIN_KEY no se crea ninguna reserva: solo las comprobaciones de solo lectura.
import { randomBytes } from 'node:crypto';

const url = (process.env.ML_SUPABASE_URL || 'https://dojgxfotawtxitgcppyn.supabase.co').replace(/\/$/, '');
const anon = process.env.ML_ANON_KEY || '';
const adminKey = process.env.ML_ADMIN_KEY || '';
if (!anon) {
  console.error('Falta ML_ANON_KEY.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

async function call(path, body, headers = {}) {
  const res = await fetch(`${url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // `details` llega como texto JSON (PostgREST lo exige): se parsea igual que el front.
  if (data && typeof data.details === 'string') {
    try {
      data.details = JSON.parse(data.details);
    } catch {
      /* texto normal */
    }
  }
  return { status: res.status, data };
}
const rpc = (fn, body = {}) => call(`/rest/v1/rpc/${fn}`, body);

const rnd = () => randomBytes(3).toString('hex');
const book = (slot, user, extra = {}) =>
  rpc('ml_book', {
    p_slot_start: slot,
    p_discord_username: user,
    p_display_name: 'Prueba humo',
    p_riot_id: 'Smoke#TEST',
    p_main_role: 'flex',
    p_message: 'prueba automatica, se borra sola',
    p_privacy_accepted: true,
    p_website: null,
    ...extra,
  });

async function main() {
  console.log(`Humo contra ${url}`);
  const s = await rpc('ml_slots');
  check('ml_slots 200 con schemaVersion >= 1', s.status === 200 && s.data.schemaVersion >= 1, JSON.stringify(s.data).slice(0, 200));
  check('ml_slots: 14 dias de 9 cupos de 40 min, UTC-5', s.data.days?.length === 14 && s.data.days[1].slots.length === 9 && s.data.utcOffset === '-05:00' && s.data.slotMinutes === 40);
  check('ml_slots no expone datos de nadie', s.data.days.flatMap((d) => d.slots).every((x) => Object.keys(x).sort().join() === 'available,end,start'));

  // Errores que NO guardan nada: comprueban que PostgREST traduce bien cada codigo.
  const lastDay = s.data.days.at(-1).slots;
  const target = lastDay.at(-1); // ultimo cupo del dia mas lejano
  const bad = await book(target.start, 'Juan Perez', { p_display_name: '' });
  check('validacion -> 400 validation_error con details por campo (el caso que dio 500)', bad.status === 400 && bad.data.code === 'validation_error' && !!bad.data.details?.discordUsername && !!bad.data.details?.displayName, JSON.stringify(bad));
  const off = await book(new Date(Date.parse(target.start) + 60000).toISOString(), 'zz.smoke.off');
  check('cupo fuera de la grilla -> 422 slot_not_bookable', off.status === 422 && off.data.code === 'slot_not_bookable' && off.data.details?.reason === 'outside_schedule', JSON.stringify(off));
  const hp = await book(target.start, 'zz.smoke.hp', { p_website: 'spam' });
  check('honeypot -> 400 bad_request', hp.status === 400 && hp.data.code === 'bad_request');
  check('cancelar con un token falso -> 404 not_found', (await rpc('ml_booking_cancel', { p_token: 'x' })).status === 404);

  // Seguridad
  check('la integracion con anon se deniega (401/403, 42501)', [401, 403].includes((await rpc('ml_integration_pending', {})).status));
  const direct = await call('/rest/v1/booking', null, { 'Accept-Profile': 'mountain_lords' });
  check('tabla del esquema con anon -> 406 PGRST106 (esquema no expuesto)', direct.status === 406 && direct.data.code === 'PGRST106', JSON.stringify(direct));
  const noKey = await rpc('ml_admin_agenda', { p_key: 'clave-mala' });
  check('admin con clave mala -> 401 unauthorized', noKey.status === 401 && noKey.data.code === 'unauthorized', JSON.stringify(noKey));

  if (!adminKey) {
    console.log('  (sin ML_ADMIN_KEY: no se crea ninguna reserva de prueba ni se prueba el admin)');
    return;
  }

  const ag = await rpc('ml_admin_agenda', { p_key: adminKey });
  check('admin con la clave buena -> 200 con 14 dias', ag.status === 200 && ag.data.days?.length === 14);
  const before = ag.data.days.flatMap((d) => d.slots).filter((x) => x.state === 'booked').length;

  try {
    const user = `zz.smoke.${rnd()}`;
    const ok = await book(target.start, user);
    if (ok.status === 429) {
      console.log('  (rate_limited: esta IP ya uso hoy sus 3 reservas; se omite el flujo de reserva)');
    } else {
      check('reservar -> 200 con manageToken', ok.status === 200 && ok.data.manageToken?.length === 43, JSON.stringify(ok));
      const taken = await book(target.start, `zz.smoke.${rnd()}`);
      check('mismo cupo -> 409 slot_taken', taken.status === 409 && taken.data.code === 'slot_taken');
      const dup = await book(lastDay.at(-2).start, user);
      check('mismo usuario en otro cupo -> 409 already_booked', dup.status === 409 && dup.data.code === 'already_booked');
      const look = await rpc('ml_booking_lookup', { p_token: ok.data.manageToken });
      check('lookup no cancela', look.status === 200 && look.data.booking.status === 'confirmed');
      const can = await rpc('ml_booking_cancel', { p_token: ok.data.manageToken });
      check('cancelar -> 200', can.status === 200 && can.data.status === 'cancelled');
      const blocked = await rpc('ml_admin_block', { p_key: adminKey, p_slot_start: target.start });
      check('desbloqueable tras cancelar: bloquear -> 200', blocked.status === 200);
      check('desbloquear -> 200', (await rpc('ml_admin_unblock', { p_key: adminKey, p_slot_start: target.start })).status === 200);
    }
  } finally {
    // Siempre se limpia, aunque algo haya fallado a medias.
    const purge = await rpc('ml_admin_purge_test', { p_key: adminKey });
    check('purga de las reservas de prueba -> 200', purge.status === 200, JSON.stringify(purge));
    const after = await rpc('ml_admin_agenda', { p_key: adminKey });
    const left = after.data.days?.flatMap((d) => d.slots).filter((x) => x.state === 'booked' && /^zz\.smoke\./.test(x.booking?.discordUsername ?? '')).length;
    check('no queda ninguna reserva zz.smoke.', left === 0, String(left));
    check('las reservas reales siguen igual', after.data.days.flatMap((d) => d.slots).filter((x) => x.state === 'booked').length === before);
  }
}

main()
  .catch((e) => {
    failed++;
    console.error('Humo abortado:', e.message);
  })
  .finally(() => {
    console.log(`\n${passed} correctas, ${failed} fallidas`);
    process.exit(failed ? 1 : 0);
  });
