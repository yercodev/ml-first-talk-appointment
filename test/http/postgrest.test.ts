// Pruebas HTTP contra un PostgREST REAL (el del CI: postgrest/postgrest contra el postgres:16 del job).
// Comprueban lo que PGlite no puede: que PostgREST acepta el MESSAGE de cada RAISE y lo traduce al estado HTTP
// correcto (400/401/409/422/429), que `details` llega como texto, y los permisos de anon vistos desde la API.
// Sin POSTGREST_URL (en local) se saltan.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.POSTGREST_URL;
const DB = process.env.TEST_DATABASE_URL;
const ADMIN_KEY = 'clave-http-de-prueba';

interface Res {
  status: number;
  body: any;
}

async function rpc(fn: string, args: Record<string, unknown> = {}, ip?: string): Promise<Res> {
  const res = await fetch(`${URL_}/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip ?? `10.${rnd()}.${rnd()}.${rnd()}` },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const rnd = () => Math.floor(Math.random() * 250);
const uniq = () => randomBytes(3).toString('hex');

const book = (start: string, user: string, extra: Record<string, unknown> = {}, ip?: string) =>
  rpc('ml_book', { p_slot_start: start, p_discord_username: user, p_display_name: 'Prueba Http', p_privacy_accepted: true, ...extra }, ip);

const details = (b: any) => {
  expect(typeof b.details).toBe('string'); // PostgREST lo exige como texto
  return JSON.parse(b.details);
};

describe.skipIf(!URL_ || !DB)('PostgREST real: las RPC ml_*', () => {
  let pg: any;
  let slots: string[] = [];

  beforeAll(async () => {
    const { Client } = await import('pg');
    pg = new Client({ connectionString: DB });
    await pg.connect();
    await pg.query(`update mountain_lords.settings set allow_fake_now = false, fake_now = null, max_bookings_per_ip_per_day = 3,
      admin_key_hash = extensions.crypt($1, extensions.gen_salt('bf', 4))`, [ADMIN_KEY]);
    await pg.query('delete from mountain_lords.booking');
    await pg.query('delete from mountain_lords.slot_block');
    await pg.query('delete from mountain_lords.admin_fail');
    const s = await rpc('ml_slots');
    slots = s.body.days.slice(3).flatMap((d: any) => d.slots.filter((x: any) => x.available).map((x: any) => x.start));
  });

  afterAll(async () => {
    await rpc('ml_admin_purge_test', { p_key: ADMIN_KEY });
    await pg.query('delete from mountain_lords.booking');
    await pg.end();
  });

  it('ml_slots -> 200 con la grilla', async () => {
    const r = await rpc('ml_slots');
    expect(r.status).toBe(200);
    expect(r.body.schemaVersion).toBe(1);
    expect(r.body.days).toHaveLength(14);
  });

  it('reserva correcta -> 200 con booking y manageToken; lookup 200; cancelar 200; token falso 404', async () => {
    const r = await book(slots[0]!, `zz.smoke.${uniq()}`);
    expect(r.status).toBe(200);
    expect(r.body.manageToken).toHaveLength(43);
    const look = await rpc('ml_booking_lookup', { p_token: r.body.manageToken });
    expect(look.status).toBe(200);
    expect(look.body.booking.status).toBe('confirmed');
    expect((await rpc('ml_booking_cancel', { p_token: r.body.manageToken })).status).toBe(200);
    const bad = await rpc('ml_booking_lookup', { p_token: 'inventado' });
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('not_found');
  });

  it('validacion -> 400 validation_error con details como texto JSON y sus campos (el caso que dio 500)', async () => {
    const r = await book(slots[1]!, `zz.smoke.${uniq()}`, { p_display_name: '', p_riot_id: 'sin tag' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_error');
    expect(Object.keys(details(r.body)).sort()).toEqual(['displayName', 'riotId']);
  });

  it('cupo tomado -> 409 slot_taken; el mismo usuario en otro cupo -> 409 already_booked', async () => {
    const user = `zz.smoke.${uniq()}`;
    expect((await book(slots[2]!, user)).status).toBe(200);
    const taken = await book(slots[2]!, `zz.smoke.${uniq()}`);
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('slot_taken');
    const dup = await book(slots[3]!, user);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('already_booked');
  });

  it('cupo fuera de la rejilla -> 422 slot_not_bookable con reason en details', async () => {
    const r = await book(new Date(Date.parse(slots[4]!) + 60_000).toISOString(), `zz.smoke.${uniq()}`);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('slot_not_bookable');
    expect(details(r.body).reason).toBe('outside_schedule');
  });

  it('honeypot -> 400 bad_request generico', async () => {
    const r = await book(slots[5]!, `zz.smoke.${uniq()}`, { p_website: 'spam' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_request');
  });

  it('la cuarta reserva desde la misma IP -> 429 rate_limited', async () => {
    const ip = `203.0.113.${rnd()}`;
    for (let i = 0; i < 3; i++) expect((await book(slots[6 + i]!, `zz.smoke.${uniq()}`, {}, ip)).status).toBe(200);
    const r = await book(slots[9]!, `zz.smoke.${uniq()}`, {}, ip);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('rate_limited');
  });

  it('admin sin clave o con clave mala -> 401 unauthorized (response.status); con la clave buena -> 200', async () => {
    for (const key of [null, 'mala']) {
      const r = await rpc('ml_admin_agenda', { p_key: key });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('unauthorized');
    }
    const ok = await rpc('ml_admin_agenda', { p_key: ADMIN_KEY });
    expect(ok.status).toBe(200);
    expect(ok.body.days).toHaveLength(14);
  });

  it('bloquear un cupo reservado -> 409 slot_booked; purgar las reservas de prueba -> 200', async () => {
    const booked = slots[2]!;
    const r = await rpc('ml_admin_block', { p_key: ADMIN_KEY, p_slot_start: booked });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('slot_booked');
    const p = await rpc('ml_admin_purge_test', { p_key: ADMIN_KEY });
    expect(p.status).toBe(200);
    expect(p.body.purged).toBeGreaterThan(0);
    expect((await rpc('ml_admin_purge_test', { p_key: 'mala' })).status).toBe(401);
  });

  it('la integracion con anon se deniega y no cambia nada', async () => {
    for (const [fn, args] of [['ml_integration_pending', {}], ['ml_integration_ack', { p_payload: {} }]] as const) {
      const r = await rpc(fn, args as any);
      expect([401, 403]).toContain(r.status);
      expect(r.body.code).toBe('42501');
    }
  });

  it('el esquema mountain_lords no esta expuesto: 406 PGRST106; sin perfil no existe la tabla', async () => {
    const a = await fetch(`${URL_}/booking`, { headers: { 'Accept-Profile': 'mountain_lords' } });
    expect(a.status).toBe(406);
    expect((await a.json()).code).toBe('PGRST106');
    const b = await fetch(`${URL_}/booking`);
    expect(b.status).toBe(404);
  });
});
