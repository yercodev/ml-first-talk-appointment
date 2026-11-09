// Smoke test contra una instancia viva (wrangler dev o produccion).
// Uso: ADMIN_TOKEN=... node scripts/smoke.mjs http://localhost:8799
// Sin ADMIN_TOKEN se omiten las pruebas de admin con clave valida.
import { randomBytes } from 'node:crypto';

const base = (process.argv[2] || 'http://localhost:8799').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN || '';
let failed = 0;
let passed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const rnd = () => randomBytes(4).toString('hex');
const fakeIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(path, { method = 'GET', body, headers = {}, ip } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const book = (slotStart, discord, extra = {}) =>
  call('/api/bookings', {
    method: 'POST',
    ip: fakeIp(),
    body: { slotStart, discord, name: 'Smoke Test', riotId: 'Smoke#TEST', role: 'flex', note: 'prueba automatica', ...extra },
  });

const getSlots = async () => (await call('/api/slots')).data;
const findSlot = (data, start) => data.days.flatMap((d) => d.slots).find((s) => s.start === start);

async function main() {
  console.log(`Smoke contra ${base}`);

  const health = await call('/api/health');
  check('GET /api/health -> {ok:true}', health.status === 200 && health.data.ok === true);

  const slots = await getSlots();
  check('GET /api/slots trae dias con cupos', slots.days.length > 0 && slots.slotMinutes === 40 && !!slots.timezone.label);
  check('GET /api/slots no expone quien reservo', slots.days.flatMap((d) => d.slots).every((s) => Object.keys(s).sort().join() === 'start,status,time'));
  const free = slots.days.slice(2).flatMap((d) => d.slots.filter((s) => s.status === 'free'));
  if (free.length < 4) throw new Error('No hay cupos libres suficientes para probar');
  const [A, B, C, D] = [free[0].start, free[1].start, free[2].start, free[3].start];

  const user1 = `smoke_${rnd()}`;
  const r1 = await book(A, user1);
  check('reserva OK -> 201 con id, slotStart y cancelToken', r1.status === 201 && r1.data.id && r1.data.slotStart === A && r1.data.cancelToken?.length >= 30, JSON.stringify(r1));

  const r2 = await book(A, `smoke_${rnd()}`);
  check('mismo cupo -> 409 slot_taken', r2.status === 409 && r2.data.error === 'slot_taken', JSON.stringify(r2));

  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => book(C, `smoke_par${i}_${rnd()}`)));
  const oks = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409 && r.data.error === 'slot_taken');
  check('10 reservas en paralelo al mismo cupo -> exactamente 1 OK', oks.length === 1, `ok=${oks.length}`);
  check('las otras 9 reciben 409', conflicts.length === 9, `409=${conflicts.length}`);

  const r3 = await book(B, user1);
  check('mismo usuario en otro cupo -> 409 already_booked', r3.status === 409 && r3.data.error === 'already_booked', JSON.stringify(r3));

  const r3b = await book(B, `@${user1.toUpperCase()}`);
  check('el usuario se normaliza (@, mayusculas) -> sigue siendo 409', r3b.status === 409 && r3b.data.error === 'already_booked');

  for (const bad of ['Juan Perez', 'juan#1234', 'a', 'x..y']) {
    const rb = await book(B, bad);
    check(`usuario invalido ${JSON.stringify(bad)} -> 400`, rb.status === 400 && rb.data.error === 'validation' && /nombre de usuario|Ajustes/.test(rb.data.message), JSON.stringify(rb));
  }

  const rBadSlot = await book(A + 60_000, `smoke_${rnd()}`);
  check('cupo que no existe -> 400', rBadSlot.status === 400, JSON.stringify(rBadSlot));

  const rNoJson = await fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  check('sin JSON -> 415', rNoJson.status === 415);

  const rHp = await book(D, `smoke_${rnd()}`, { website: 'http://spam.example' });
  check('honeypot relleno -> 201 falso', rHp.status === 201);
  check('honeypot no guarda nada (el cupo sigue libre)', findSlot(await getSlots(), D)?.status === 'free');

  const cancelBad = await call('/api/bookings/cancel', { method: 'POST', body: { id: r1.data.id, token: 'token-incorrecto' } });
  check('cancelar con token incorrecto -> 404', cancelBad.status === 404);
  check('el cupo sigue ocupado tras el intento fallido', findSlot(await getSlots(), A)?.status === 'taken');
  const cancelOk = await call('/api/bookings/cancel', { method: 'POST', body: { id: r1.data.id, token: r1.data.cancelToken } });
  check('cancelar con el token bueno -> 200', cancelOk.status === 200);
  check('el cupo vuelve a quedar libre', findSlot(await getSlots(), A)?.status === 'free');
  const cancelTwice = await call('/api/bookings/cancel', { method: 'POST', body: { id: r1.data.id, token: r1.data.cancelToken } });
  check('cancelar dos veces -> 404', cancelTwice.status === 404);
  const r4 = await book(A, user1);
  check('tras cancelar se puede volver a reservar', r4.status === 201, JSON.stringify(r4));

  const noKey = await call('/api/admin/agenda');
  check('admin sin clave -> 401', noKey.status === 401);
  const badKey = await call('/api/admin/agenda', { headers: { Authorization: 'Bearer clave-mala' } });
  check('admin con clave mala -> 401', badKey.status === 401);
  const noKeyTick = await call('/api/admin/tick', { method: 'POST' });
  check('admin/tick sin clave -> 401', noKeyTick.status === 401);

  if (adminToken) {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const ag = await call('/api/admin/agenda', { headers: auth });
    const adminSlot = ag.data.days?.flatMap((d) => d.slots).find((s) => s.start === A);
    check('admin con clave -> agenda con detalles de la reserva', ag.status === 200 && adminSlot?.status === 'booked' && adminSlot.booking?.discord === user1 && adminSlot.booking.inServer === false, JSON.stringify(adminSlot));

    const blk = await call('/api/admin/blocks', { method: 'POST', headers: auth, body: { slotStart: B } });
    check('bloquear -> 200', blk.status === 200, JSON.stringify(blk));
    check('el cupo bloqueado sale taken', findSlot(await getSlots(), B)?.status === 'taken');
    const rBlocked = await book(B, `smoke_${rnd()}`);
    check('reservar un cupo bloqueado -> 409', rBlocked.status === 409, JSON.stringify(rBlocked));
    const blkBooked = await call('/api/admin/blocks', { method: 'POST', headers: auth, body: { slotStart: A } });
    check('bloquear un cupo reservado -> 409', blkBooked.status === 409);
    const unblk = await call(`/api/admin/blocks/${B}`, { method: 'DELETE', headers: auth });
    check('desbloquear -> 200', unblk.status === 200);
    check('el cupo desbloqueado vuelve a free', findSlot(await getSlots(), B)?.status === 'free');

    const adminCancel = await call(`/api/admin/bookings/${r4.data.id}/cancel`, { method: 'POST', headers: auth });
    check('admin cancela una reserva -> 200', adminCancel.status === 200);
    check('...y el cupo queda libre', findSlot(await getSlots(), A)?.status === 'free');

    const winner = oks[0]?.data;
    if (winner) await call(`/api/admin/bookings/${winner.id}/cancel`, { method: 'POST', headers: auth });
    const tick = await call('/api/admin/tick', { method: 'POST', headers: auth });
    check('admin/tick -> 200', tick.status === 200 && tick.data.ran === true, JSON.stringify(tick));
  } else {
    console.log('  (sin ADMIN_TOKEN: se omiten las pruebas de admin con clave valida)');
  }

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke abortado:', e.message);
  process.exit(1);
});
