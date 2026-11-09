import type { Agenda } from './agenda';
import { loadConfig, type Env } from './config';
import { formatDateEs } from './format';
import {
  ValidationError,
  validateDiscordUsername,
  validateDisplayName,
  validateNote,
  validateRiotId,
  validateRole,
} from './validate';

export { Agenda } from './agenda';

const MAX_BODY = 8 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function err(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newCancelToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** Comparacion en tiempo constante: se comparan los hashes, que siempre miden lo mismo. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function stub(env: Env) {
  return env.AGENDA.get(env.AGENDA.idFromName('main'));
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    return err(415, 'unsupported_media_type', 'La petición debe enviarse como JSON.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return err(413, 'too_large', 'La petición es demasiado grande.');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('no objeto');
    return body as Record<string, unknown>;
  } catch {
    return err(400, 'bad_json', 'No se pudo leer la petición.');
  }
}

async function handleBooking(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const cfg = loadConfig(env);

  // Honeypot: un bot rellena el campo oculto. Se responde OK falso sin guardar nada.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ id: 'ok', slotStart: Number(body.slotStart) || 0, cancelToken: newCancelToken() }, 201);
  }

  let fields;
  try {
    const slotStart = body.slotStart;
    if (typeof slotStart !== 'number' || !Number.isSafeInteger(slotStart)) {
      throw new ValidationError('Elige un horario para tu charla.', 'slotStart');
    }
    fields = {
      slotStart,
      discordUsername: validateDiscordUsername(body.discord),
      displayName: validateDisplayName(body.name),
      riotId: validateRiotId(body.riotId),
      mainRole: validateRole(body.role),
      note: validateNote(body.note),
    };
  } catch (e) {
    if (e instanceof ValidationError) return json({ error: 'validation', field: e.field, message: e.message }, 400);
    throw e;
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const salt = env.IP_SALT || `salt:${env.ADMIN_TOKEN ?? 'ml-first-talk'}`;
  const ipHash = await sha256Hex(`${ip}|${salt}`);
  const cancelToken = newCancelToken();
  const cancelTokenHash = await sha256Hex(cancelToken);

  const result = await stub(env).book({ ...fields, ipHash, cancelTokenHash });
  if (result.ok) {
    ctx.waitUntil(stub(env).tick().catch((e) => console.log(`[tick] ${(e as Error).message}`)));
    return json({ id: result.id, slotStart: result.slotStart, cancelToken }, 201);
  }
  switch (result.error) {
    case 'invalid_slot':
      return err(400, 'invalid_slot', 'Ese horario no es válido o ya no tiene la antelación mínima. Elige otro.');
    case 'slot_taken':
      return err(409, 'slot_taken', 'Alguien acaba de tomar ese horario. Elige otro disponible.');
    case 'already_booked':
      return err(
        409,
        'already_booked',
        `Ya tienes una charla agendada: ${formatDateEs(result.existingSlotStart, cfg.tzOffsetMin, cfg.tzLabel)}. Si quieres cambiarla, cancélala primero con tu enlace de cancelación.`,
      );
    case 'rate_limited':
      return err(429, 'rate_limited', 'Has hecho demasiadas reservas hoy desde tu conexión. Inténtalo mañana.');
  }
}

async function handleCancel(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { id, token } = body;
  if (typeof id !== 'string' || typeof token !== 'string' || id.length > 64 || token.length > 128) {
    return err(404, 'not_found', 'No encontramos esa reserva. Revisa el enlace de cancelación.');
  }
  const r = await stub(env).cancel(id, await sha256Hex(token));
  if (!r.ok) return err(404, 'not_found', 'No encontramos esa reserva, o ya estaba cancelada.');
  ctx.waitUntil(stub(env).tick().catch((e) => console.log(`[tick] ${(e as Error).message}`)));
  return json({ ok: true });
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(503, 'admin_disabled', 'El panel de administración no está configurado.');
  const header = request.headers.get('Authorization') ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!(await safeEqual(supplied, env.ADMIN_TOKEN))) return err(401, 'unauthorized', 'Clave incorrecta.');

  const path = url.pathname.replace(/^\/api\/admin/, '');
  const method = request.method;
  const s = stub(env);

  if (path === '/agenda' && method === 'GET') return json(await s.adminAgenda());
  if (path === '/tick' && method === 'POST') return json(await s.tick());

  const cancel = path.match(/^\/bookings\/([A-Za-z0-9]{1,64})\/cancel$/);
  if (cancel && method === 'POST') {
    const r = await s.adminCancel(cancel[1]!);
    return r.ok ? json({ ok: true }) : err(404, 'not_found', 'Reserva no encontrada.');
  }

  if (path === '/blocks' && method === 'POST') {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (typeof body.slotStart !== 'number') return err(400, 'validation', 'Falta slotStart.');
    const r = await s.adminBlock(body.slotStart);
    if (r.ok) return json({ ok: true });
    if (r.error === 'slot_booked') return err(409, 'slot_booked', 'Ese cupo tiene una reserva: cancélala primero.');
    return err(400, 'invalid_slot', 'Ese cupo no existe en la agenda.');
  }

  const unblock = path.match(/^\/blocks\/(\d{1,16})$/);
  if (unblock && method === 'DELETE') {
    const r = await s.adminUnblock(Number(unblock[1]));
    return r.ok ? json({ ok: true }) : err(404, 'not_found', 'Ese cupo no estaba bloqueado.');
  }

  return err(404, 'not_found', 'Ruta no encontrada.');
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return json({ ok: true });
      if (url.pathname === '/api/slots' && request.method === 'GET') return json(await stub(env).getSlots());
      if (url.pathname === '/api/bookings' && request.method === 'POST') return await handleBooking(request, env, ctx);
      if (url.pathname === '/api/bookings/cancel' && request.method === 'POST') return await handleCancel(request, env, ctx);
      if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(request, env, url);
      if (url.pathname.startsWith('/api/')) return err(404, 'not_found', 'Ruta no encontrada.');
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.log(`[api] error: ${(e as Error).stack ?? e}`);
      return err(500, 'internal', 'Algo falló de nuestro lado. Inténtalo de nuevo en un momento.');
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(stub(env).tick());
  },
} satisfies ExportedHandler<Env>;
