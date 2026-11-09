import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION, setup, type Db, type Harness } from './db';

const ADMIN_KEY = 'clave-admin-de-prueba';
const MIN = 60_000;
// Reloj de pruebas: martes 10-nov-2026, 12:00 m. hora Colombia (17:00 UTC).
const T0 = '2026-11-10T17:00:00Z';

/** Inicio del cupo `idx` (0-8) del dia `day` (0 = martes 10-nov). 16:30 COT = 21:30 UTC. */
const slotMs = (day: number, idx = 0) => Date.UTC(2026, 10, 10 + day, 21, 30) + idx * 40 * MIN;
const slot = (day: number, idx = 0) => new Date(slotMs(day, idx)).toISOString().replace('.000Z', 'Z');

let h: Harness;
let db: Db;

const q = (sql: string, params?: unknown[]) => db.query(sql, params);
const setNow = (iso: string) => q(`update mountain_lords.settings set allow_fake_now = true, fake_now = $1`, [iso]);
const setIp = (ip: string | null) =>
  q(`select set_config('request.headers', $1, false)`, [ip ? JSON.stringify({ 'cf-connecting-ip': ip }) : '']);

interface Res {
  ok: boolean;
  status: number;
  data: any;
}

/** Llama a public.<fn>(nombre => valor, ...). Los RAISE de la API se convierten en { ok:false, status, data:{code,...} }. */
async function rpc(fn: string, args: Record<string, unknown> = {}, d: Db = db): Promise<Res> {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  try {
    const rows = await d.query(
      sql,
      keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])),
    );
    const data = rows[0].r;
    return { ok: !(data && data.code), status: data && data.code ? -1 : 200, data };
  } catch (e: any) {
    if (e.code === 'PGRST') return { ok: false, status: JSON.parse(e.detail).status, data: JSON.parse(e.message) };
    throw e;
  }
}

const book = (start: string | null, user: string, extra: Record<string, unknown> = {}, d: Db = db) =>
  rpc(
    'ml_book',
    { p_slot_start: start, p_discord_username: user, p_display_name: 'Lord Aim', p_privacy_accepted: true, ...extra },
    d,
  );

const asRole = async <T>(role: string, f: () => Promise<T>): Promise<T> => {
  await q(`set role ${role}`);
  try {
    return await f();
  } finally {
    await q('reset role');
  }
};

const slotsOf = async () => (await rpc('ml_slots')).data;
const isAvailable = async (start: string) =>
  (await slotsOf()).days.flatMap((d: any) => d.slots).find((s: any) => s.start === start)?.available;
const svc = (fn: string, args: Record<string, unknown>) => asRole('service_role', () => rpc(fn, args));

interface Member {
  id: string;
  username: string;
  bot?: boolean;
}

/** Una ejecucion de n8n con Discord simulado: pending -> roles y mensajes -> ack -> mensajes -> ack. */
async function n8nRun(
  opts: { members?: Member[]; roleFails?: boolean; sendFails?: boolean } = {},
) {
  const members = opts.members ?? [];
  const log = { roles: [] as string[], messages: [] as any[] };
  const pend = (await svc('ml_integration_pending', { p_dry_run: false })).data;
  const find = (u: string) => members.find((m) => !m.bot && m.username.toLowerCase() === u);
  const links = pend.linkCandidates
    .map((c: any) => ({ c, m: find(c.discordUsername) }))
    .filter((x: any) => x.m)
    .map((x: any) => {
      if (!opts.roleFails) log.roles.push(x.c.discordUsername);
      return { bookingId: x.c.bookingId, discordUserId: x.m.id, roleOk: !opts.roleFails, error: opts.roleFails ? 'Discord 403' : undefined };
    });
  const presence = pend.presenceChecks.map((p: any) => ({
    bookingId: p.bookingId,
    present: members.some((m) => m.id === p.discordUserId),
  }));
  const send = (list: any[]) =>
    list.map((n) => {
      if (!opts.sendFails) log.messages.push(n);
      return { notificationId: n.id, ok: !opts.sendFails, error: opts.sendFails ? 'Discord 500' : undefined };
    });
  const first = send(pend.notifications);
  const ack1 = (await svc('ml_integration_ack', { p_payload: { dryRun: false, membersListed: true, links, presence, results: first } })).data;
  const second = send(ack1.notifications);
  if (second.length) {
    await svc('ml_integration_ack', { p_payload: { dryRun: false, membersListed: false, links: [], presence: [], results: second } });
  }
  return { pend, ack1, log };
}

const texts = (log: { messages: any[] }) => log.messages.map((m) => m.content as string);
const hasAgenda = (log: { messages: any[] }) => texts(log).some((x) => /^Agenda de hoy/.test(x));

beforeAll(async () => {
  h = await setup();
  db = h.db;
});
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await q('reset role');
  await q('delete from mountain_lords.notification');
  await q('delete from mountain_lords.booking');
  await q('delete from mountain_lords.slot_block');
  await q('delete from mountain_lords.admin_fail');
  await q(`update mountain_lords.integration_run set last_run_at = null`);
  await q(
    `update mountain_lords.settings set utc_offset = '-05:00', day_start = '16:30', day_end = '22:30', slot_minutes = 40,
      window_days = 14, min_lead_minutes = 60, max_bookings_per_ip_per_day = 3, retention_days = 30, reminder_minutes = 15,
      daily_agenda_time = '16:00', lease_seconds = 120, admin_key_hash = extensions.crypt($1, extensions.gen_salt('bf', 4))`,
    [ADMIN_KEY],
  );
  await setNow(T0);
  await setIp(null);
});

describe('migracion', () => {
  it('se puede aplicar dos veces (idempotente) y el reloj de pruebas viene apagado', async () => {
    await q(MIGRATION);
    await q(MIGRATION);
    expect(await q(`select 1 from mountain_lords.settings`)).toHaveLength(1);
    await q(`update mountain_lords.settings set allow_fake_now = false, fake_now = null`);
    // Una instalacion limpia deja allow_fake_now = false: se comprueba en el default de la columna.
    expect((await q(`select column_default from information_schema.columns where table_schema = 'mountain_lords' and table_name = 'settings' and column_name = 'allow_fake_now'`))[0].column_default).toBe('false');
    await setNow(T0);
  });
});

describe('escenario 1: la grilla', () => {
  it('14 dias, 9 cupos de 40 min, 16:30 COT = 21:30 UTC y el ultimo cruza la medianoche UTC', async () => {
    const s = await slotsOf();
    expect(s.days).toHaveLength(14);
    expect(s.days[0].date).toBe('2026-11-10');
    expect(s.days[13].date).toBe('2026-11-23');
    expect(s.utcOffset).toBe('-05:00');
    expect(s.slotMinutes).toBe(40);
    expect(s.schemaVersion).toBe(1);
    for (const d of s.days) expect(d.slots).toHaveLength(9);
    expect(s.days[0].slots[0].start).toBe('2026-11-10T21:30:00Z');
    expect(s.days[0].slots[8].start).toBe('2026-11-11T02:50:00Z'); // 9:50 PM del martes 10
    expect(s.days[0].slots[8].end).toBe('2026-11-11T03:30:00Z'); // termina 10:30 PM
  });

  it('cambiar la configuracion cambia la grilla sin desplegar nada (slot_minutes = 30, day_end = 21:30 -> 10 cupos)', async () => {
    await q(`update mountain_lords.settings set slot_minutes = 30, day_end = '21:30'`);
    const day = (await slotsOf()).days[0];
    expect(day.slots).toHaveLength(10);
    expect(day.slots[9].end).toBe('2026-11-11T02:30:00Z'); // 9:30 PM
  });

  it('a las 02:00 UTC (9 PM del 10) todavia es martes; a las 05:00 UTC ya es miercoles', async () => {
    await setNow('2026-11-11T02:00:00Z');
    expect((await slotsOf()).days[0].date).toBe('2026-11-10');
    await setNow('2026-11-11T05:00:00Z');
    expect((await slotsOf()).days[0].date).toBe('2026-11-11');
  });
});

describe('formato de fechas en espanol (listas propias)', () => {
  const f = async (fn: string, iso: string) => (await q(`select mountain_lords.${fn}($1::timestamptz) as r`, [iso]))[0].r;
  it('corto, largo y hora de 12 h', async () => {
    expect(await f('fmt_short', '2026-11-12T22:10:00Z')).toBe('jue 12-nov, 5:10 PM');
    expect(await f('fmt_long_day', '2026-11-12T22:10:00Z')).toBe('jueves 12 de noviembre');
    expect(await f('fmt_day_short', '2026-11-10T17:00:00Z')).toBe('mar 10-nov');
    expect(await f('fmt_time', '2026-11-08T17:00:00Z')).toBe('12:00 PM');
    expect(await f('fmt_time', '2026-11-08T05:05:00Z')).toBe('12:05 AM');
  });
  it('usa el dia local, no el UTC (9:50 PM del martes es el miercoles en UTC)', async () => {
    expect(await f('fmt_short', '2026-11-11T02:50:00Z')).toBe('mar 10-nov, 9:50 PM');
  });
  it('escapa el markdown y las menciones', async () => {
    const e = async (s: string) => (await q(`select mountain_lords.md_escape($1) as r`, [s]))[0].r;
    expect(await e('**hola** _x_ ~~y~~ `z`')).toBe('\\*\\*hola\\*\\* \\_x\\_ \\~\\~y\\~\\~ \\`z\\`');
    expect(await e('@everyone <@123> <#456>')).toBe('\\@everyone \\<\\@123\\> \\<\\#456\\>');
    expect(await e('Hola, soy Juan 123')).toBe('Hola, soy Juan 123');
  });
});

describe('escenarios 2, 3, 5 y 11: reservar y lo que ve el publico', () => {
  it('reserva OK: 200 con booking y manageToken de 32 bytes base64url; solo se guarda el hash', async () => {
    const r = await book(slot(1, 1), 'lord.aim', { p_riot_id: 'LordAim#LAT', p_main_role: 'duelista', p_message: 'hola' });
    expect(r.ok).toBe(true);
    expect(r.data.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.data.booking).toMatchObject({ slotStart: slot(1, 1), discordUsername: 'lord.aim', displayName: 'Lord Aim', status: 'confirmed' });
    const [row] = await q(`select manage_token_hash from mountain_lords.booking`);
    expect(row.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(r.data.manageToken);
    expect(await isAvailable(slot(1, 1))).toBe(false);
  });

  it('cupo tomado o bloqueado -> 409 slot_taken (igual para el publico)', async () => {
    await book(slot(1), 'user_a');
    const taken = await book(slot(1), 'user_b');
    expect(taken.status).toBe(409);
    expect(taken.data.code).toBe('slot_taken');
    await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_slot_start: slot(2) });
    const blocked = await book(slot(2), 'user_b');
    expect(blocked.status).toBe(409);
    expect(blocked.data.code).toBe('slot_taken');
  });

  it('una charla futura por usuario -> 409 already_booked; al cancelar se puede volver a reservar', async () => {
    const a = await book(slot(1), 'lord.aim');
    const r = await book(slot(2), '  @Lord.Aim ');
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('already_booked');
    await rpc('ml_booking_cancel', { p_token: a.data.manageToken });
    expect((await book(slot(2), 'lord.aim')).ok).toBe(true);
  });

  it('el publico solo ve disponible / no disponible: ni usuarios, ni nicks, ni bloqueado vs tomado', async () => {
    await book(slot(1), 'secreto_user', { p_display_name: 'Nombre Secreto' });
    await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_slot_start: slot(2) });
    const s = await slotsOf();
    expect(JSON.stringify(s)).not.toMatch(/secreto|Secreto/);
    expect(s.days.flatMap((d: any) => d.slots).every((x: any) => Object.keys(x).sort().join() === 'available,end,start')).toBe(true);
    expect(await isAvailable(slot(1))).toBe(false);
    expect(await isAvailable(slot(2))).toBe(false);
    expect(await isAvailable(slot(3))).toBe(true);
  });
});

describe('escenarios 6 y 7: validacion', () => {
  it.each([['Lord Aim'], ['l'], ['x'.repeat(33)], ['lord..aim'], ['lord-aim'], ['lordaim#1234'], ['']])(
    'usuario de Discord %j -> 400 validation_error en discordUsername',
    async (user) => {
      const r = await book(slot(1), user);
      expect(r.status).toBe(400);
      expect(r.data.code).toBe('validation_error');
      expect(Object.keys(r.data.details)).toEqual(['discordUsername']);
      expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(0);
      expect(await isAvailable(slot(1))).toBe(true);
    },
  );

  it('el formato antiguo tiene su propio texto', async () => {
    expect((await book(slot(1), 'lordaim#1234')).data.details.discordUsername).toMatch(/formato antiguo/);
  });

  it('se normaliza: "  @Lord.Aim  " se guarda como lord.aim; lord_aim.99 pasa', async () => {
    expect((await book(slot(1), '  @Lord.Aim  ')).data.booking.discordUsername).toBe('lord.aim');
    expect((await book(slot(2), 'lord_aim.99')).ok).toBe(true);
  });

  it('nick, Riot ID, rol, mensaje y privacidad', async () => {
    const f = async (extra: Record<string, unknown>) => Object.keys((await book(slot(1), 'user_ok', extra)).data.details ?? {});
    expect(await f({ p_display_name: '' })).toEqual(['displayName']);
    expect(await f({ p_display_name: 'x'.repeat(33) })).toEqual(['displayName']);
    expect(await f({ p_riot_id: 'LordAim' })).toEqual(['riotId']);
    expect(await f({ p_main_role: 'sniper' })).toEqual(['mainRole']);
    expect(await f({ p_message: 'x'.repeat(301) })).toEqual(['message']);
    expect(await f({ p_privacy_accepted: false })).toEqual(['privacyAccepted']);
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(0);
    expect((await book(slot(1), 'user_ok', { p_message: 'x'.repeat(300), p_riot_id: 'Mr Lord#1234', p_main_role: 'Flex' })).ok).toBe(true);
  });

  it('solo usuario, nick y casilla: los opcionales quedan vacios', async () => {
    const r = await book(slot(1), 'solo_lo_basico');
    expect(r.data.booking).toMatchObject({ riotId: null, mainRole: null, message: null });
  });
});

describe('escenario 8: cupos no reservables', () => {
  beforeEach(async () => {
    await setNow('2026-11-10T21:00:00Z'); // martes 10, 4:00 PM COT
  });

  it.each([
    ['2026-11-10T21:00:00Z', 422, 'outside_schedule'], // 4:00 PM
    ['2026-11-10T21:50:00Z', 422, 'outside_schedule'], // 4:50 PM (no cae en la grilla)
    ['2026-11-11T03:30:00Z', 422, 'outside_schedule'], // 10:30 PM
    ['2026-11-09T22:10:00Z', 422, 'past'], // 9-nov 5:10 PM
    ['2026-11-10T21:30:00Z', 422, 'too_soon'], // 4:30 PM (faltan 30 min)
    ['2026-11-10T22:10:00Z', 200, null], // 5:10 PM (faltan 70 min)
    ['2026-11-24T02:50:00Z', 200, null], // 23-nov 9:50 PM: el ultimo de la ventana
    ['2026-11-24T21:30:00Z', 422, 'beyond_window'], // 24-nov 4:30 PM
  ])('%s -> %i %s', async (start, status, reason) => {
    const r = await book(start, `user_${Math.random().toString(36).slice(2, 8)}`);
    expect(r.status).toBe(status);
    if (reason) {
      expect(r.data.code).toBe('slot_not_bookable');
      expect(r.data.details.reason).toBe(reason);
    }
  });

  it('ningun 422 guarda nada ni encola avisos', async () => {
    await book('2026-11-10T21:30:00Z', 'user_a');
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(0);
    expect(await q(`select 1 from mountain_lords.notification`)).toHaveLength(0);
  });
});

describe('escenario 9: honeypot', () => {
  it('400 bad_request generico, sin guardar ni encolar nada', async () => {
    const r = await book(slot(1), 'user_a', { p_website: 'http://spam.example' });
    expect(r.status).toBe(400);
    expect(r.data.code).toBe('bad_request');
    expect(JSON.stringify(r.data)).not.toMatch(/website/i);
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(0);
    expect(await q(`select 1 from mountain_lords.notification`)).toHaveLength(0);
    expect(await isAvailable(slot(1))).toBe(true);
  });
});

describe('escenario 10: 3 reservas al dia por IP', () => {
  it('la cuarta -> 429 (aunque una este cancelada); otra IP puede; al dia siguiente tambien; la IP no se guarda', async () => {
    await setIp('203.0.113.7');
    const a = await book(slot(1, 0), 'user_0');
    await book(slot(1, 1), 'user_1');
    await book(slot(1, 2), 'user_2');
    await rpc('ml_booking_cancel', { p_token: a.data.manageToken });
    const r = await book(slot(1, 3), 'user_3');
    expect(r.status).toBe(429);
    expect(r.data.code).toBe('rate_limited');
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(3);
    await setIp('203.0.113.8');
    expect((await book(slot(1, 3), 'user_3')).ok).toBe(true);
    await setIp('203.0.113.7');
    await setNow('2026-11-11T17:00:00Z'); // al dia siguiente (hora Colombia)
    expect((await book(slot(2, 4), 'user_4')).ok).toBe(true);
    expect(JSON.stringify(await q(`select * from mountain_lords.booking`))).not.toContain('203.0.113');
  });

  it('x-forwarded-for: se usa el primer valor; sin IP no se limita', async () => {
    await q(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' })]);
    for (let i = 0; i < 3; i++) expect((await book(slot(1, i), `fwd_${i}`)).ok).toBe(true);
    expect((await book(slot(1, 5), 'fwd_9')).status).toBe(429);
    await setIp(null);
    for (let i = 0; i < 4; i++) expect((await book(slot(2, i), `sin_ip_${i}`)).ok).toBe(true);
  });
});

describe('escenario 12: cancelar con el enlace', () => {
  it('lookup no cancela; cancelar libera el cupo y avisa una vez; repetir no hace nada; token falso -> 404; desde el inicio -> 409', async () => {
    const a = await book(slot(1, 1), 'lord.aim');
    const t = a.data.manageToken;
    expect((await rpc('ml_booking_lookup', { p_token: t })).data.booking).toMatchObject({ status: 'confirmed', cancelledBy: null });
    expect(await isAvailable(slot(1, 1))).toBe(false);

    expect((await rpc('ml_booking_cancel', { p_token: t })).data).toEqual({ status: 'cancelled', alreadyCancelled: false });
    expect(await isAvailable(slot(1, 1))).toBe(true);
    expect((await rpc('ml_booking_lookup', { p_token: t })).data.booking).toMatchObject({ status: 'cancelled', cancelledBy: 'aspirant' });
    expect((await rpc('ml_booking_cancel', { p_token: t })).data).toEqual({ status: 'cancelled', alreadyCancelled: true });
    expect(await q(`select 1 from mountain_lords.notification where kind = 'cancel'`)).toHaveLength(1);

    expect((await rpc('ml_booking_lookup', { p_token: 'inventado' })).status).toBe(404);
    expect((await rpc('ml_booking_cancel', { p_token: t + 'x' })).data.code).toBe('not_found');

    const b = await book(slot(2, 1), 'sova.main');
    await setNow(new Date(slotMs(2, 1)).toISOString()); // justo a la hora de inicio
    const late = await rpc('ml_booking_cancel', { p_token: b.data.manageToken });
    expect(late.status).toBe(409);
    expect(late.data.code).toBe('already_started');
  });

  it('el DM de cancelacion dice si ya tenia ML-temp', async () => {
    const a = await book(slot(2, 1), 'lord.aim', { p_display_name: 'LordAim' });
    await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    await rpc('ml_booking_cancel', { p_token: a.data.manageToken });
    const run = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    expect(texts(run.log)).toEqual(['Cancelada: LordAim (lord.aim), jue 12-nov, 5:10 PM. El horario queda libre.\nYa tenía ML-temp y lo conserva.']);
  });
});

describe('escenarios 13, 14, 17 y 29: el rol y los avisos (n8n simulado)', () => {
  it('13: al entrar al servidor se pone el rol una sola vez; DM "entró" y bienvenida; el nombre visible no cuenta; los bots se ignoran', async () => {
    await book(slot(2, 1), 'lord.aim', { p_display_name: 'LordAim' }); // jueves 12, 5:10 PM
    const first = await n8nRun({ members: [{ id: '1', username: 'otro_usuario' }, { id: '9', username: 'lord.aim', bot: true }] });
    expect(first.log.roles).toEqual([]);
    expect(texts(first.log)).toHaveLength(1);
    expect(texts(first.log)[0]).toMatch(/^Nueva charla: LordAim \(lord\\\.aim\)/.source ? /^Nueva charla: LordAim \(lord\.aim\)/ : /x/);

    const second = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    expect(second.log.roles).toEqual(['lord.aim']);
    expect(texts(second.log)).toEqual([
      'Ya tiene ML-temp: LordAim (lord.aim). Charla: jue 12-nov, 5:10 PM.',
      `<@111> te damos la bienvenida al proceso de Mountain Lords. Tu charla con Yerco es el jueves 12 de noviembre a las 5:10 PM (hora Colombia; en tu hora, <t:${slotMs(2, 1) / 1000}:t>) en <#1567723301856481300>. Aquí te avisamos 15 minutos antes.`,
    ]);
    expect(second.log.messages[1].allowedMentions).toEqual({ parse: [], users: ['111'] });
    expect(second.log.messages[0].allowedMentions).toEqual({ parse: [] });
    expect(second.log.messages[1].target).toEqual({ type: 'channel', id: '1567723300287815803' });
    expect(second.log.messages[0].target).toEqual({ type: 'dm', userId: '224261961502818305' });

    const third = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    expect(third.log.roles).toEqual([]);
    expect(third.log.messages).toEqual([]);
    const ag = (await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data;
    const b = ag.days.flatMap((d: any) => d.slots).find((s: any) => s.state === 'booked').booking;
    expect(b.inServer).toBe(true);
    expect(b.roleAssignedAt).toBe('2026-11-10T17:00:00Z');
  });

  it('13: si la charla ya termino, ya no es candidato y no se le pone el rol', async () => {
    await book(slot(1, 0), 'lord.aim');
    await setNow(new Date(slotMs(1, 0) + 41 * MIN).toISOString());
    const run = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    expect(run.pend.linkCandidates).toEqual([]);
    expect(run.log.roles).toEqual([]);
  });

  it('14: quien ya era miembro recibe el rol en la primera ejecucion; Yerco recibe "Nueva charla" y luego "Ya tiene ML-temp"', async () => {
    await book(slot(2, 1), 'sova.main', { p_display_name: 'Sova' });
    const run = await n8nRun({ members: [{ id: '222', username: 'sova.main' }] });
    const t = texts(run.log);
    expect(run.log.roles).toEqual(['sova.main']);
    expect(t[0]).toMatch(/^Nueva charla: Sova/);
    expect(t[1]).toMatch(/^Ya tiene ML-temp: Sova/);
    expect(t[2]).toMatch(/^<@222> te damos la bienvenida/);
  });

  it('17: si Discord rechaza el rol, no se vincula ni hay bienvenida y se reintenta en la siguiente ejecucion', async () => {
    await book(slot(2, 1), 'sova.main');
    const bad = await n8nRun({ members: [{ id: '222', username: 'sova.main' }], roleFails: true });
    expect(texts(bad.log).every((x) => !/te damos la bienvenida/.test(x))).toBe(true);
    expect((await q(`select discord_user_id from mountain_lords.booking`))[0].discord_user_id).toBeNull();
    const ok = await n8nRun({ members: [{ id: '222', username: 'sova.main' }] });
    expect(ok.log.roles).toEqual(['sova.main']);
  });

  it('29: tras una caida salen los pendientes una vez; no sale el aviso de 15 min de una charla que ya empezo; si la agenda', async () => {
    await book(slot(0, 1), 'lord.aim', { p_display_name: 'LordAim' }); // martes 10, 5:10 PM COT (22:10Z)
    await book(slot(0, 3), 'sova.main'); // 6:30 PM
    await setNow('2026-11-10T22:20:00Z'); // 5:20 PM: la de las 5:10 ya empezo
    const run = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    const t = texts(run.log);
    expect(t.filter((x) => /^Nueva charla/.test(x))).toHaveLength(2);
    expect(t.some((x) => /^En 15 min/.test(x))).toBe(false);
    expect(t.some((x) => /^Agenda de hoy, mar 10-nov: 2 charlas/.test(x))).toBe(true);
    expect((await n8nRun({ members: [] })).log.messages).toEqual([]);
  });
});

describe('escenarios 15 y 16: aviso de 15 min y agenda diaria', () => {
  it('15: DM con la presencia de esa ejecucion y mencion en #ml-temp solo si esta; no se repite; no sale desde la hora de inicio', async () => {
    await book(slot(2, 1), 'lord.aim', { p_display_name: 'LordAim', p_riot_id: 'LordAim#LAT', p_main_role: 'duelista', p_message: 'hola' });
    const here = [{ id: '111', username: 'lord.aim' }];
    await n8nRun({ members: here }); // se vincula
    await setNow('2026-11-12T21:54:00Z'); // 4:54 PM: faltan 16 min
    expect(texts((await n8nRun({ members: here })).log).some((x) => /^En 15/.test(x))).toBe(false);
    await setNow('2026-11-12T21:55:00Z'); // 4:55 PM
    const t = texts((await n8nRun({ members: here })).log);
    expect(t.find((x) => /^En 15 min/.test(x))).toBe(
      'En 15 min: LordAim (lord.aim), 5:10 PM. Está en YercoVerse: sí.\nRiot ID: LordAim\\#LAT · Rol: duelista · Mensaje: hola',
    );
    expect(t.find((x) => /^<@111> tu charla/.test(x))).toBe(
      `<@111> tu charla con Yerco empieza en 15 minutos, a las 5:10 PM (hora Colombia; en tu hora, <t:${slotMs(2, 1) / 1000}:t>), en <#1567723301856481300>.`,
    );
    await setNow('2026-11-12T21:56:00Z');
    expect(texts((await n8nRun({ members: here })).log).filter((x) => /tu charla|En 15/.test(x))).toEqual([]);
    await setNow('2026-11-12T22:10:00Z'); // desde la hora de inicio ya no sale
    expect((await n8nRun({ members: here })).log.messages).toEqual([]);
  });

  it('15: quien no ha entrado o ya salio -> "no" y nada en #ml-temp; una charla cancelada no avisa', async () => {
    await book(slot(2, 3), 'sova.main'); // 6:30 PM (23:30Z)
    const gone = await book(slot(2, 4), 'jett.main');
    await rpc('ml_booking_cancel', { p_token: gone.data.manageToken });
    await n8nRun({ members: [{ id: '222', username: 'sova.main' }] }); // se vincula
    await setNow('2026-11-12T23:20:00Z');
    const run = await n8nRun({ members: [] }); // ya salio del servidor
    const t = texts(run.log);
    expect(t.find((x) => /^En 15 min/.test(x))).toMatch(/Está en YercoVerse: no\./);
    expect(run.log.messages.filter((m) => m.target.type === 'channel')).toEqual([]);
    expect(t.some((x) => /jett/.test(x) && /^En 15/.test(x))).toBe(false);
  });

  it('15: si no corrio la ejecucion de las 4:55, sale en la primera antes de las 5:10', async () => {
    await book(slot(2, 1), 'lord.aim');
    await setNow('2026-11-12T22:05:00Z'); // 5:05 PM
    expect(texts((await n8nRun({ members: [] })).log).some((x) => /^En 15 min/.test(x))).toBe(true);
  });

  it('16: una agenda unica a las 4:00 PM con las charlas del dia (la de las 9:50, guardada con fecha UTC del 11), sin la cancelada', async () => {
    await book(slot(0, 1), 'lord.aim', { p_display_name: 'LordAim' }); // 5:10
    await book(slot(0, 3), 'sova.main', { p_display_name: 'Sova' }); // 6:30
    await book(slot(0, 8), 'jett.main', { p_display_name: 'Jett' }); // 9:50 PM
    const x = await book(slot(0, 4), 'cancelada.u', { p_display_name: 'Cancelada' }); // 7:10
    await rpc('ml_booking_cancel', { p_token: x.data.manageToken });
    await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] }); // lord.aim se vincula a las 12:00
    await setNow('2026-11-10T20:59:00Z'); // 3:59 PM
    expect(hasAgenda(await n8nRun({ members: [] }).then((r) => r.log))).toBe(false);
    await setNow('2026-11-10T21:00:00Z'); // 4:00 PM
    const run = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    expect(texts(run.log).filter((t) => /^Agenda de hoy/.test(t))).toEqual([
      'Agenda de hoy, mar 10-nov: 3 charlas\n5:10 PM · LordAim (lord.aim) · ML-temp: sí\n6:30 PM · Sova (sova.main) · ML-temp: no\n9:50 PM · Jett (jett.main) · ML-temp: no',
    ]);
    await setNow('2026-11-10T21:01:00Z');
    expect(hasAgenda((await n8nRun({ members: [] })).log)).toBe(false);
  });

  it('16: sin charlas ese dia no hay agenda; la reserva tardia manda "Nueva charla"; pasadas las 10:30 PM ya no sale', async () => {
    await setNow('2026-11-10T21:00:00Z');
    expect(texts((await n8nRun({ members: [] })).log)).toEqual([]);
    await book(slot(0, 3), 'tardia.u'); // 6:30 PM, reservada a las 4:00 PM
    const t = texts((await n8nRun({ members: [] })).log);
    expect(t.some((x) => /^Nueva charla/.test(x))).toBe(true);
    await q(`delete from mountain_lords.notification where kind = 'agenda'`);
    await setNow('2026-11-11T03:31:00Z'); // 10:31 PM
    expect(hasAgenda((await n8nRun({ members: [] })).log)).toBe(false);
  });
});

describe('escenarios 17 y 18: reintentos, lease y texto del aspirante', () => {
  it('17: un fallo reintenta con 1, 2, 4 y 8 min; al 5.º queda fallido y el admin lo ve; despues no sale', async () => {
    await book(slot(2, 1), 'lord.aim');
    let now = Date.parse(T0);
    for (const w of [1, 2, 4, 8]) {
      const run = await n8nRun({ sendFails: true });
      expect(run.pend.notifications.length).toBe(1);
      const [n] = await q(`select next_attempt_at, status from mountain_lords.notification`);
      expect(n.status).toBe('pending');
      expect(new Date(n.next_attempt_at).getTime() - now).toBe(w * MIN);
      now += w * MIN;
      await setNow(new Date(now).toISOString());
    }
    await n8nRun({ sendFails: true });
    expect((await q(`select attempts, status from mountain_lords.notification`))[0]).toEqual({ attempts: 5, status: 'failed' });
    const ag = (await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data;
    expect(ag.failedNotifications).toHaveLength(1);
    expect(ag.failedNotifications[0]).toMatchObject({ kind: 'new', error: 'Discord 500' });
    await setNow(new Date(now + 60 * MIN).toISOString());
    expect((await n8nRun({})).log.messages).toEqual([]);
  });

  it('17: un aviso reclamado no sale a la segunda ejecucion; si n8n cae vuelve al vencer el lease (120 s); retry_after manda si es mayor', async () => {
    await book(slot(2, 1), 'lord.aim');
    const pend = async () => (await svc('ml_integration_pending', { p_dry_run: false })).data;
    expect((await pend()).notifications).toHaveLength(1);
    expect((await pend()).notifications).toEqual([]); // solapada: la primera lo tiene reclamado
    await setNow(new Date(Date.parse(T0) + 119 * 1000).toISOString());
    expect((await pend()).notifications).toEqual([]);
    await setNow(new Date(Date.parse(T0) + 121 * 1000).toISOString());
    const p3 = await pend();
    expect(p3.notifications).toHaveLength(1);
    await svc('ml_integration_ack', {
      p_payload: { dryRun: false, membersListed: true, results: [{ notificationId: p3.notifications[0].id, ok: false, error: 'rate', retryAfterSeconds: 600 }] },
    });
    const [n] = await q(`select next_attempt_at from mountain_lords.notification`);
    expect(new Date(n.next_attempt_at).getTime() - Date.parse(T0) - 121 * 1000).toBe(600 * 1000);
  });

  it('18: nick @everyone y mensaje con menciones/markdown/script: escapado, sin menciones coladas y el mensaje solo va en DMs', async () => {
    await book(slot(2, 1), 'lord.aim', { p_display_name: '@everyone', p_message: 'hola <@224261961502818305> **ojo** <script>alert(1)</script>' });
    const run = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    for (const m of run.log.messages) {
      if (m.target.type === 'dm') expect(m.allowedMentions).toEqual({ parse: [] });
      else {
        expect(m.allowedMentions).toEqual({ parse: [], users: ['111'] });
        expect(m.content).not.toMatch(/ojo|script|everyone/);
      }
    }
    const dm = run.log.messages.find((m) => /^Nueva charla/.test(m.content));
    expect(dm.content).toContain('\\@everyone');
    expect(dm.content).toContain('\\<\\@224261961502818305\\>');
    expect(dm.content).toContain('\\*\\*ojo\\*\\*');
    expect(dm.content).toContain('\\<script\\>');
    expect(dm.content).not.toMatch(/(^|[^\\])<@224261961502818305>/);
  });
});

describe('correcciones de QA (F-1, F-5, R-5)', () => {
  it('F-1: sin presencia real no se afirma "Está en YercoVerse: no" (ack sin presence, o sin membersListed)', async () => {
    await book(slot(2, 1), 'lord.aim', { p_display_name: 'LordAim' });
    await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] }); // se vincula
    await setNow('2026-11-12T21:56:00Z'); // 4:56 PM: ya toca el aviso de 15 min
    const ack = (payload: object) => svc('ml_integration_ack', { p_payload: { dryRun: false, links: [], results: [], ...payload } });
    expect((await ack({ membersListed: true, presence: [] })).data.notifications).toEqual([]); // vinculado, sin comprobacion
    expect((await ack({ membersListed: false, presence: [{ bookingId: (await q(`select id from mountain_lords.booking`))[0].id, present: true }] })).data.notifications).toEqual([]);
    expect(await q(`select 1 from mountain_lords.notification where kind like 'reminder%'`)).toHaveLength(0);
    // con la presencia real, sale una sola vez y bien
    const id = (await q(`select id from mountain_lords.booking`))[0].id;
    const ok = (await ack({ membersListed: true, presence: [{ bookingId: id, present: true }] })).data.notifications;
    expect(ok.map((n: any) => n.kind)).toEqual(['reminder-dm', 'reminder-ch']);
    expect(ok[0].content).toMatch(/Está en YercoVerse: sí\./);
  });

  it('F-1: el rol fallido de esa ejecucion no genera un "no" falso', async () => {
    await book(slot(2, 1), 'sova.main');
    await setNow('2026-11-12T21:56:00Z');
    const id = (await q(`select id from mountain_lords.booking`))[0].id;
    const r = (await svc('ml_integration_ack', { p_payload: { dryRun: false, membersListed: true, links: [{ bookingId: id, discordUserId: '5', roleOk: false, error: 'Discord 403' }], presence: [], results: [] } })).data;
    expect(r.notifications.some((n: any) => /^En 15 min/.test(n.content))).toBe(false);
  });

  it('F-5: retryAfterSeconds decimal no rompe el ack y se redondea hacia arriba', async () => {
    await book(slot(2, 1), 'lord.aim');
    const pend = (await svc('ml_integration_pending', { p_dry_run: false })).data;
    const r = await svc('ml_integration_ack', {
      p_payload: { dryRun: false, membersListed: false, results: [{ notificationId: pend.notifications[0].id, ok: false, error: 'rate', retryAfterSeconds: 1.5 }] },
    });
    expect(r.ok).toBe(true);
    const [n] = await q(`select attempts, next_attempt_at from mountain_lords.notification`);
    expect(n.attempts).toBe(1);
    expect(new Date(n.next_attempt_at).getTime() - Date.parse(T0)).toBe(60_000); // gana el backoff de 1 min
    const r2 = await svc('ml_integration_ack', {
      p_payload: { dryRun: false, membersListed: false, results: [{ notificationId: pend.notifications[0].id, ok: false, retryAfterSeconds: 90.2 }] },
    });
    expect(r2.ok).toBe(true);
  });

  it('R-5: el texto del aspirante no puede forjar lineas ni cabeceras en los DMs a Yerco, y se corta', async () => {
    const msg = 'hola\n# Está en YercoVerse: sí.\r\nNueva charla: falsa\t ' + 'x'.repeat(200);
    await book(slot(2, 1), 'lord.aim', { p_display_name: 'Lord Aim', p_riot_id: 'Lord#LAT', p_message: msg });
    const dm = (await svc('ml_integration_pending', { p_dry_run: false })).data.notifications.find((n: any) => n.kind === 'new').content as string;
    const lines = dm.split('\n');
    expect(lines).toHaveLength(4); // Nueva charla / Riot ID y mensaje / presencia / Agenda: solo las del bot
    expect(lines[0]).toMatch(/^Nueva charla: Lord Aim \(lord\.aim\)/);
    expect(lines.filter((l) => /^Nueva charla/.test(l))).toHaveLength(1);
    expect(dm).not.toContain('\r');
    expect(dm).not.toContain('\t');
    expect(lines[1]!.length).toBeLessThan(330);
    expect(lines[1]).toContain(String.raw`\# Está en YercoVerse\: sí.`);
  });
});

describe('textos y version del aviso (marketing ML-001)', () => {
  it('N-7: cada reserva guarda la version del aviso de privacidad aceptado, que fija el servidor', async () => {
    await book(slot(1), 'user_a');
    expect((await q(`select privacy_version from mountain_lords.booking`))[0].privacy_version).toBe('2026-11-10');
    await q(`update mountain_lords.settings set privacy_version = '2026-12-01'`);
    await book(slot(2), 'user_b');
    expect((await q(`select privacy_version from mountain_lords.booking order by slot_start`)).map((r: any) => r.privacy_version)).toEqual(['2026-11-10', '2026-12-01']);
    await q(`update mountain_lords.settings set privacy_version = '2026-11-10'`);
  });

  it('O-3: la consulta de la reserva trae el enlace de invitacion a YercoVerse', async () => {
    const a = await book(slot(1), 'user_a');
    expect((await rpc('ml_booking_lookup', { p_token: a.data.manageToken })).data.inviteUrl).toBe('https://discord.gg/9m2MhhgPHv');
  });

  it('R-15: los avisos hablan de ML-temp, no de estar en YercoVerse (salvo el de 15 min, que mira la presencia real)', async () => {
    await book(slot(2, 1), 'lord.aim', { p_display_name: 'LordAim' });
    const nueva = (await svc('ml_integration_pending', { p_dry_run: false })).data.notifications[0].content as string;
    expect(nueva).toBe('Nueva charla: LordAim (lord.aim), jue 12-nov, 5:10 PM\nAún no tiene ML-temp.\nAgenda: https://yercodev.github.io/ml-first-talk-appointment/admin.html');
    expect(nueva).not.toMatch(/ /); // en Discord, espacio normal
  });

  it('B-3 / O-2: la bienvenida no promete el equipo y lleva la hora de Discord; ningun aviso usa "bienvenido"', async () => {
    await book(slot(2, 1), 'lord.aim');
    const run = await n8nRun({ members: [{ id: '111', username: 'lord.aim' }] });
    const welcome = texts(run.log).find((x) => /te damos la bienvenida/.test(x))!;
    expect(welcome).toContain(`<t:${slotMs(2, 1) / 1000}:t>`);
    expect(welcome).toContain('(hora Colombia; en tu hora,');
    expect(texts(run.log).some((x) => /bienvenido/.test(x))).toBe(false);
  });
});

describe('escenarios 19, 20 y 21: administracion', () => {
  it('19: bloquear/desbloquear un cupo y un dia; un cupo reservado no se bloquea; un dia con reservas bloquea solo los libres', async () => {
    const b = await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_date: '2026-11-19' });
    expect(b.data).toEqual({ blocked: 9, skippedBooked: 0 });
    expect((await book(slot(9, 1), 'user_a')).status).toBe(409);
    expect((await slotsOf()).days.find((d: any) => d.date === '2026-11-19').slots.every((s: any) => !s.available)).toBe(true);
    await rpc('ml_admin_unblock', { p_key: ADMIN_KEY, p_slot_start: slot(9, 8) });
    expect(await isAvailable(slot(9, 8))).toBe(true);
    expect(await isAvailable(slot(9, 7))).toBe(false);

    await book(slot(10, 3), 'lord.aim'); // vie 20-nov 6:30 PM
    const one = await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_slot_start: slot(10, 3) });
    expect(one.status).toBe(409);
    expect(one.data.code).toBe('slot_booked');
    expect((await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_date: '2026-11-20' })).data).toEqual({ blocked: 8, skippedBooked: 1 });
    expect(await q(`select 1 from mountain_lords.booking where status = 'confirmed'`)).toHaveLength(1);
  });

  it('20: cancelar desde admin -> "por Yerco", libera el cupo, no avisa y el aspirante lo ve', async () => {
    const a = await book(slot(2, 1), 'lord.aim');
    const id = a.data.booking.id;
    expect((await rpc('ml_admin_cancel', { p_key: ADMIN_KEY, p_booking_id: id })).data).toEqual({ status: 'cancelled' });
    expect(await isAvailable(slot(2, 1))).toBe(true);
    expect((await rpc('ml_booking_lookup', { p_token: a.data.manageToken })).data.booking).toMatchObject({ status: 'cancelled', cancelledBy: 'admin' });
    expect(await q(`select 1 from mountain_lords.notification`)).toHaveLength(0);
    expect((await rpc('ml_admin_cancel', { p_key: ADMIN_KEY, p_booking_id: id })).status).toBe(404);
  });

  it('21: sin clave, vacia o incorrecta -> 401 unauthorized sin datos y sin cambios; con el hash vacio toda clave es incorrecta', async () => {
    const a = await book(slot(2, 1), 'lord.aim');
    for (const key of [null, '', 'mala']) {
      const r = await rpc('ml_admin_agenda', { p_key: key });
      expect(r.data).toMatchObject({ code: 'unauthorized' });
      expect(Object.keys(r.data).sort()).toEqual(['code', 'details', 'hint', 'message']);
    }
    expect((await rpc('ml_admin_cancel', { p_key: 'mala', p_booking_id: a.data.booking.id })).data.code).toBe('unauthorized');
    expect((await rpc('ml_admin_block', { p_key: 'mala', p_slot_start: slot(3) })).data.code).toBe('unauthorized');
    expect(await q(`select 1 from mountain_lords.booking where status = 'confirmed'`)).toHaveLength(1);
    expect(await q(`select 1 from mountain_lords.slot_block`)).toHaveLength(0);
    await q(`update mountain_lords.settings set admin_key_hash = ''`);
    expect((await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data.code).toBe('unauthorized');
  });

  it('21: con la clave buena trae 14 dias; los intentos fallidos se registran y a los 10 se bloquea 15 min aunque la clave sea buena', async () => {
    await setIp('203.0.113.9');
    const ok = (await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data;
    expect(ok.days).toHaveLength(14);
    expect(ok.days[0].slots[0]).toHaveProperty('state', 'free');
    for (let i = 0; i < 10; i++) await rpc('ml_admin_agenda', { p_key: 'mala' });
    expect(await q(`select 1 from mountain_lords.admin_fail`)).toHaveLength(10);
    expect((await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data.code).toBe('rate_limited');
    await setNow(new Date(Date.parse(T0) + 16 * MIN).toISOString());
    expect((await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data.days).toHaveLength(14);
    await setIp('203.0.113.10'); // otra IP no esta bloqueada
    expect((await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data.days).toHaveLength(14);
  });

  it('E: la ultima ejecucion de n8n sale en la agenda', async () => {
    expect((await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data.lastIntegrationRunAt).toBeNull();
    await n8nRun({});
    expect((await rpc('ml_admin_agenda', { p_key: ADMIN_KEY })).data.lastIntegrationRunAt).toBe('2026-11-10T17:00:00Z');
  });
});

describe('escenario 22: borrado 30 dias despues', () => {
  it('la reserva sigue 30 dias tras terminar la charla y se borra despues, con sus avisos; tambien las canceladas', async () => {
    const a = await book(slot(2, 1), 'lord.aim'); // jue 12-nov 5:10 PM -> termina 5:50 PM
    const c = await book(slot(2, 0), 'sova.main');
    await rpc('ml_booking_cancel', { p_token: c.data.manageToken });
    await setNow('2026-12-12T22:49:00Z'); // 12-dic 5:49 PM COT
    await svc('ml_integration_pending', { p_dry_run: false });
    expect(await q(`select 1 from mountain_lords.booking where id = $1`, [a.data.booking.id])).toHaveLength(1);
    await setNow('2026-12-12T22:51:00Z');
    const p = (await svc('ml_integration_pending', { p_dry_run: false })).data;
    expect(p.cleaned).toBeGreaterThan(0);
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(0);
    expect(await q(`select 1 from mountain_lords.notification`)).toHaveLength(0);
  });

  it('con dry_run no se borra nada; los bloqueos y los intentos de clave antiguos se borran', async () => {
    await book(slot(2, 1), 'lord.aim');
    await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_slot_start: slot(3, 0) });
    await rpc('ml_admin_agenda', { p_key: 'mala' });
    await setNow('2026-12-20T17:00:00Z');
    const dry = (await svc('ml_integration_pending', { p_dry_run: true })).data;
    expect(dry.cleaned).toBeGreaterThan(0);
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(1);
    expect(await q(`select 1 from mountain_lords.slot_block`)).toHaveLength(1);
    await svc('ml_integration_pending', { p_dry_run: false });
    expect(await q(`select 1 from mountain_lords.booking`)).toHaveLength(0);
    expect(await q(`select 1 from mountain_lords.slot_block`)).toHaveLength(0);
    expect(await q(`select 1 from mountain_lords.admin_fail`)).toHaveLength(0);
  });
});

describe('escenario 26 (parte SQL): dry_run no escribe nada', () => {
  it('pending y ack con dry_run calculan lo mismo y no dejan rastro (ni leases, ni vinculos, ni avisos nuevos)', async () => {
    await book(slot(2, 1), 'lord.aim');
    const snapshot = async () => JSON.stringify(await q(`select id, status, lease_until, attempts from mountain_lords.notification order by id`));
    const before = await snapshot();
    const pend = (await svc('ml_integration_pending', { p_dry_run: true })).data;
    expect(pend.notifications).toHaveLength(1);
    expect(pend.linkCandidates).toHaveLength(1);
    expect(await snapshot()).toBe(before);
    expect((await q(`select last_run_at from mountain_lords.integration_run`))[0].last_run_at).toBeNull();

    const ack = (
      await svc('ml_integration_ack', {
        p_payload: {
          dryRun: true,
          membersListed: true,
          links: [{ bookingId: pend.linkCandidates[0].bookingId, discordUserId: '111', roleOk: true }],
          presence: [],
          results: [{ notificationId: pend.notifications[0].id, ok: true }],
        },
      })
    ).data;
    expect(ack.notifications.map((n: any) => n.kind)).toEqual(['joined', 'welcome']);
    expect((await q(`select discord_user_id from mountain_lords.booking`))[0].discord_user_id).toBeNull();
    expect(await q(`select 1 from mountain_lords.notification`)).toHaveLength(1);
    expect((await q(`select status from mountain_lords.notification`))[0].status).toBe('pending');
  });
});

describe('escenarios 27 y 28: permisos', () => {
  it('27: la integracion se deniega a anon y authenticated y se permite a service_role; los privilegios estan revocados', async () => {
    for (const role of ['anon', 'authenticated']) {
      await asRole(role, async () => {
        await expect(rpc('ml_integration_pending', { p_dry_run: false })).rejects.toThrow(/permission denied/i);
        await expect(rpc('ml_integration_ack', { p_payload: {} })).rejects.toThrow(/permission denied/i);
      });
    }
    for (const sig of ['public.ml_integration_pending(boolean)', 'public.ml_integration_ack(jsonb)']) {
      for (const role of ['anon', 'authenticated']) {
        expect((await q(`select has_function_privilege('${role}', '${sig}', 'execute') as p`))[0].p).toBe(false);
      }
      expect((await q(`select has_function_privilege('service_role', '${sig}', 'execute') as p`))[0].p).toBe(true);
    }
    expect((await svc('ml_integration_pending', { p_dry_run: false })).data.now).toBeTruthy();
  });

  it('27: sigue denegado aunque el entorno de Supabase conceda EXECUTE por defecto en las funciones nuevas de public', async () => {
    await q(`alter default privileges in schema public grant execute on functions to anon, authenticated, service_role`);
    try {
      await q(`drop function public.ml_integration_pending(boolean)`);
      await q(`drop function public.ml_integration_ack(jsonb)`);
      await q(MIGRATION);
      for (const sig of ['public.ml_integration_pending(boolean)', 'public.ml_integration_ack(jsonb)']) {
        expect((await q(`select has_function_privilege('anon', '${sig}', 'execute') as p`))[0].p).toBe(false);
        expect((await q(`select has_function_privilege('authenticated', '${sig}', 'execute') as p`))[0].p).toBe(false);
      }
    } finally {
      await q(`alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role`);
    }
  });

  it('28: anon y authenticated no leen ninguna tabla del esquema ni llaman a sus funciones internas', async () => {
    await book(slot(1), 'lord.aim');
    for (const role of ['anon', 'authenticated']) {
      await asRole(role, async () => {
        for (const t of ['booking', 'settings', 'slot_block', 'notification', 'admin_fail', 'integration_run']) {
          await expect(q(`select * from mountain_lords.${t}`)).rejects.toThrow(/permission denied/i);
        }
        await expect(q(`select mountain_lords.clock()`)).rejects.toThrow(/permission denied/i);
        await expect(q(`select mountain_lords.pending_core()`)).rejects.toThrow(/permission denied/i);
      });
    }
    const pub = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ml\\_%'`);
    expect(pub).toHaveLength(10);
  });

  it('28: con allow_fake_now = false un fake_now puesto no cambia la hora de nada', async () => {
    await q(`update mountain_lords.settings set allow_fake_now = false, fake_now = '2000-01-01T00:00:00Z'`);
    expect((await slotsOf()).now.slice(0, 4)).not.toBe('2000');
  });
});

describe('escenarios 4 y 5 con carrera real (solo con Postgres real, en CI)', () => {
  it('10 reservas al mismo cupo desde 10 conexiones distintas -> exactamente 1 OK', async (ctx) => {
    if (!h.newClient) return ctx.skip();
    await q(`update mountain_lords.settings set allow_fake_now = false`);
    const start = (await slotsOf()).days.at(-1).slots[0].start;
    const clients = await Promise.all(Array.from({ length: 10 }, () => h.newClient!()));
    try {
      const results = await Promise.all(clients.map((c, i) => book(start, `race_user_${i}`, {}, c)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 && r.data.code === 'slot_taken')).toHaveLength(9);
      expect(await q(`select 1 from mountain_lords.booking where slot_start = $1`, [start])).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });

  it('el mismo usuario pidiendo 6 cupos distintos a la vez -> exactamente 1 OK (advisory lock)', async (ctx) => {
    if (!h.newClient) return ctx.skip();
    await q(`update mountain_lords.settings set allow_fake_now = false`);
    const starts = (await slotsOf()).days.at(-1).slots.slice(0, 6).map((s: any) => s.start);
    const clients = await Promise.all(starts.map(() => h.newClient!()));
    try {
      const results = await Promise.all(clients.map((c, i) => book(starts[i], 'mismo_usuario', {}, c)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.data.code === 'already_booked')).toHaveLength(5);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
});
