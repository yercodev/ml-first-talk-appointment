// Prueba de humo contra Supabase real (staging), por REST, igual que lo hace el front.
//   ML_SUPABASE_URL=https://xxx.supabase.co ML_ANON_KEY=... [ML_ADMIN_KEY=...] node scripts/smoke.mjs
// Usa 1 de las 3 reservas diarias por IP (la reserva se cancela al final).
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
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const rpc = (fn, body = {}) => call(`/rest/v1/rpc/${fn}`, body);

async function main() {
  console.log(`Humo contra ${url}`);
  const s = await rpc('ml_slots');
  check('ml_slots 200 con schemaVersion >= 1', s.status === 200 && s.data.schemaVersion >= 1, JSON.stringify(s.data).slice(0, 200));
  check('ml_slots: 14 dias de 9 cupos de 40 min, UTC-5', s.data.days?.length === 14 && s.data.days[1].slots.length === 9 && s.data.utcOffset === '-05:00' && s.data.slotMinutes === 40);
  check('ml_slots no expone datos de nadie', s.data.days.flatMap((d) => d.slots).every((x) => Object.keys(x).sort().join() === 'available,end,start'));

  const free = s.data.days.slice(3).flatMap((d) => d.slots).filter((x) => x.available);
  const base = { p_display_name: 'Smoke Test', p_privacy_accepted: true };
  const bad = await rpc('ml_book', { ...base, p_slot_start: free[0].start, p_discord_username: 'Juan Perez' });
  check('usuario invalido -> 400 validation_error', bad.status === 400 && bad.data.code === 'validation_error' && !!bad.data.details.discordUsername, JSON.stringify(bad));
  const hp = await rpc('ml_book', { ...base, p_slot_start: free[0].start, p_discord_username: 'smoke_hp', p_website: 'x' });
  check('honeypot -> 400 bad_request', hp.status === 400 && hp.data.code === 'bad_request');
  const off = await rpc('ml_book', { ...base, p_slot_start: new Date(Date.parse(free[0].start) + 60000).toISOString(), p_discord_username: 'smoke_off' });
  check('cupo fuera de la grilla -> 422 slot_not_bookable', off.status === 422 && off.data.details?.reason === 'outside_schedule');

  const user = `smoke_${randomBytes(3).toString('hex')}`;
  const ok = await rpc('ml_book', { ...base, p_slot_start: free[0].start, p_discord_username: user });
  if (ok.status === 429) {
    console.log('  (rate_limited: ya se uso el cupo antispam de esta IP hoy; se omite el resto del flujo)');
  } else {
    check('reservar -> 200 con manageToken', ok.status === 200 && ok.data.manageToken?.length === 43, JSON.stringify(ok));
    const dup = await rpc('ml_book', { ...base, p_slot_start: free[1].start, p_discord_username: user });
    check('mismo usuario otro cupo -> 409 already_booked', dup.status === 409 && dup.data.code === 'already_booked');
    const look = await rpc('ml_booking_lookup', { p_token: ok.data.manageToken });
    check('lookup no cancela', look.status === 200 && look.data.booking.status === 'confirmed');
    const can = await rpc('ml_booking_cancel', { p_token: ok.data.manageToken });
    check('cancelar -> 200', can.status === 200 && can.data.status === 'cancelled');
    check('token falso -> 404', (await rpc('ml_booking_lookup', { p_token: 'x' })).status === 404);
  }

  const integ = await rpc('ml_integration_pending', {});
  check('integracion con anon -> 401/403 (no 200)', integ.status === 401 || integ.status === 403, String(integ.status));
  const direct = await call('/rest/v1/booking', null, { 'Accept-Profile': 'mountain_lords' });
  check('tabla del esquema con anon -> error de esquema no expuesto', direct.status >= 400 && direct.data.code === 'PGRST106', JSON.stringify(direct));
  const noKey = await rpc('ml_admin_agenda', { p_key: 'clave-mala' });
  check('admin con clave mala -> 401 unauthorized', noKey.status === 401 && noKey.data.code === 'unauthorized', JSON.stringify(noKey));
  if (adminKey) {
    const ag = await rpc('ml_admin_agenda', { p_key: adminKey });
    check('admin con la clave buena -> 200 con 14 dias', ag.status === 200 && ag.data.days?.length === 14);
  } else {
    console.log('  (sin ML_ADMIN_KEY: se omite la prueba con la clave buena)');
  }

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Humo abortado:', e.message);
  process.exit(1);
});
