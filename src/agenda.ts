import { DurableObject } from 'cloudflare:workers';
import { loadConfig, type Config, type Env } from './config';
import { DiscordClient } from './discord';
import { dayShort, escapeMarkdown, formatDateEs, formatTime12 } from './format';
import { bookableDays, generateDays, isBookableSlot, localDateStr, localMinuteOfDay } from './slots';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 5;
const MAX_PER_IP_PER_DAY = 3;

type SqlVal = string | number | null;

export interface BookingInput {
  slotStart: number;
  discordUsername: string;
  displayName: string;
  riotId: string | null;
  mainRole: string | null;
  note: string | null;
  ipHash: string;
  cancelTokenHash: string;
}

export type BookResult =
  | { ok: true; id: string; slotStart: number }
  | { ok: false; error: 'invalid_slot' | 'slot_taken' | 'rate_limited' }
  | { ok: false; error: 'already_booked'; existingSlotStart: number };

export type MutationResult = { ok: true } | { ok: false; error: string };

interface BookingRow {
  id: string;
  slot_start: number;
  discord_username: string;
  display_name: string;
  riot_id: string | null;
  main_role: string | null;
  note: string | null;
  status: 'booked' | 'cancelled';
  created_at: number;
  ip_hash: string;
  cancel_token_hash: string;
  discord_user_id: string | null;
  role_assigned_at: number | null;
  role_notified_at: number | null;
  notified_at: number | null;
  welcomed_at: number | null;
  reminded_at: number | null;
  reminder_pinged_at: number | null;
  cancel_notified_at: number | null;
  fails: string;
}

type NotifyCol =
  | 'notified_at'
  | 'role_assigned_at'
  | 'role_notified_at'
  | 'welcomed_at'
  | 'reminded_at'
  | 'reminder_pinged_at'
  | 'cancel_notified_at';

export class Agenda extends DurableObject<Env> {
  private cfg: Config;
  private discord: DiscordClient;
  private ticking = false;
  private tickAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = loadConfig(env);
    this.discord = new DiscordClient(this.cfg, env.DISCORD_BOT_TOKEN, {
      get: (u) => this.metaGet(`dm:${u}`),
      set: (u, c) => this.metaSet(`dm:${u}`, c),
    });
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  // ---------------------------------------------------------------- SQL

  private q<T = Record<string, SqlVal>>(sql: string, ...args: SqlVal[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...args).toArray() as T[];
  }

  private migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      slot_start INTEGER NOT NULL,
      discord_username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      riot_id TEXT,
      main_role TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'booked',
      created_at INTEGER NOT NULL,
      ip_hash TEXT NOT NULL,
      cancel_token_hash TEXT NOT NULL,
      discord_user_id TEXT,
      role_assigned_at INTEGER,
      role_notified_at INTEGER,
      notified_at INTEGER,
      welcomed_at INTEGER,
      reminded_at INTEGER,
      reminder_pinged_at INTEGER,
      cancel_notified_at INTEGER,
      fails TEXT NOT NULL DEFAULT '{}'
    )`);
    sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_slot_booked ON bookings(slot_start) WHERE status = 'booked'`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS ix_bookings_user ON bookings(discord_username, status)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS blocks (slot_start INTEGER PRIMARY KEY)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rate (ip_hash TEXT NOT NULL, at INTEGER NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS ix_rate_ip ON rate(ip_hash, at)`);
  }

  private metaGet(k: string): string | null {
    const r = this.q<{ v: string }>('SELECT v FROM meta WHERE k = ?', k);
    return r[0]?.v ?? null;
  }

  private metaSet(k: string, v: string) {
    this.q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  // ---------------------------------------------------------------- Publico

  async getSlots(): Promise<{
    timezone: { offsetMinutes: number; label: string };
    slotMinutes: number;
    inviteUrl: string;
    days: { date: string; slots: { start: number; time: string; status: 'free' | 'taken' }[] }[];
  }> {
    const now = Date.now();
    const taken = this.takenSet();
    const days = bookableDays(now, this.cfg).map((d) => ({
      date: d.date,
      slots: d.slots.map((s) => ({
        start: s.start,
        time: s.time,
        status: (taken.has(s.start) ? 'taken' : 'free') as 'free' | 'taken',
      })),
    }));
    return {
      timezone: { offsetMinutes: this.cfg.tzOffsetMin, label: this.cfg.tzLabel },
      slotMinutes: this.cfg.slotMinutes,
      inviteUrl: this.cfg.inviteUrl,
      days,
    };
  }

  private takenSet(): Set<number> {
    const set = new Set<number>();
    for (const r of this.q<{ slot_start: number }>(`SELECT slot_start FROM bookings WHERE status = 'booked'`))
      set.add(r.slot_start);
    for (const r of this.q<{ slot_start: number }>('SELECT slot_start FROM blocks')) set.add(r.slot_start);
    return set;
  }

  /** Todo es sincrono entre comprobar e insertar: el DO serializa las peticiones. */
  async book(input: BookingInput): Promise<BookResult> {
    const now = Date.now();
    if (!isBookableSlot(input.slotStart, now, this.cfg)) return { ok: false, error: 'invalid_slot' };

    if (this.q('SELECT 1 FROM blocks WHERE slot_start = ?', input.slotStart).length)
      return { ok: false, error: 'slot_taken' };
    if (this.q(`SELECT 1 FROM bookings WHERE slot_start = ? AND status = 'booked'`, input.slotStart).length)
      return { ok: false, error: 'slot_taken' };

    const mine = this.q<{ slot_start: number }>(
      `SELECT slot_start FROM bookings WHERE discord_username = ? AND status = 'booked' AND slot_start + ? > ? ORDER BY slot_start LIMIT 1`,
      input.discordUsername,
      this.cfg.slotMinutes * MIN,
      now,
    );
    if (mine[0]) return { ok: false, error: 'already_booked', existingSlotStart: mine[0].slot_start };

    const recent = this.q<{ n: number }>(
      'SELECT COUNT(*) AS n FROM rate WHERE ip_hash = ? AND at > ?',
      input.ipHash,
      now - DAY,
    );
    if ((recent[0]?.n ?? 0) >= MAX_PER_IP_PER_DAY) return { ok: false, error: 'rate_limited' };

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    try {
      this.q(
        `INSERT INTO bookings (id, slot_start, discord_username, display_name, riot_id, main_role, note, status, created_at, ip_hash, cancel_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)`,
        id,
        input.slotStart,
        input.discordUsername,
        input.displayName,
        input.riotId,
        input.mainRole,
        input.note,
        now,
        input.ipHash,
        input.cancelTokenHash,
      );
    } catch {
      // El indice unico parcial es la ultima barrera.
      return { ok: false, error: 'slot_taken' };
    }
    this.q('INSERT INTO rate (ip_hash, at) VALUES (?, ?)', input.ipHash, now);
    return { ok: true, id, slotStart: input.slotStart };
  }

  async cancel(id: string, tokenHash: string): Promise<MutationResult> {
    const r = this.q(
      `UPDATE bookings SET status = 'cancelled' WHERE id = ? AND cancel_token_hash = ? AND status = 'booked' RETURNING id`,
      id,
      tokenHash,
    );
    return r.length ? { ok: true } : { ok: false, error: 'not_found' };
  }

  // ---------------------------------------------------------------- Admin

  async adminAgenda() {
    const now = Date.now();
    const blocks = new Set(this.q<{ slot_start: number }>('SELECT slot_start FROM blocks').map((r) => r.slot_start));
    const booked = new Map<number, BookingRow>();
    for (const b of this.q<BookingRow>(`SELECT * FROM bookings WHERE status = 'booked'`)) booked.set(b.slot_start, b);
    const limit = now + this.cfg.minLeadMinutes * MIN;
    return {
      now,
      timezone: { offsetMinutes: this.cfg.tzOffsetMin, label: this.cfg.tzLabel },
      days: generateDays(now, this.cfg).map((d) => ({
        date: d.date,
        slots: d.slots.map((s) => {
          const b = booked.get(s.start);
          return {
            start: s.start,
            time: s.time,
            past: s.end <= now,
            bookable: s.start >= limit,
            status: b ? 'booked' : blocks.has(s.start) ? 'blocked' : 'free',
            booking: b
              ? {
                  id: b.id,
                  discord: b.discord_username,
                  name: b.display_name,
                  riotId: b.riot_id,
                  role: b.main_role,
                  note: b.note,
                  createdAt: b.created_at,
                  inServer: (b.role_assigned_at ?? 0) > 0,
                }
              : null,
          };
        }),
      })),
    };
  }

  async adminCancel(id: string): Promise<MutationResult> {
    const r = this.q(
      `UPDATE bookings SET status = 'cancelled', cancel_notified_at = ? WHERE id = ? AND status = 'booked' RETURNING id`,
      Date.now(),
      id,
    );
    return r.length ? { ok: true } : { ok: false, error: 'not_found' };
  }

  async adminBlock(slotStart: number): Promise<MutationResult> {
    const now = Date.now();
    const valid = generateDays(now, this.cfg).some((d) => d.slots.some((s) => s.start === slotStart && s.end > now));
    if (!valid) return { ok: false, error: 'invalid_slot' };
    if (this.q(`SELECT 1 FROM bookings WHERE slot_start = ? AND status = 'booked'`, slotStart).length)
      return { ok: false, error: 'slot_booked' };
    this.q('INSERT OR IGNORE INTO blocks (slot_start) VALUES (?)', slotStart);
    return { ok: true };
  }

  async adminUnblock(slotStart: number): Promise<MutationResult> {
    const r = this.q('DELETE FROM blocks WHERE slot_start = ? RETURNING slot_start', slotStart);
    return r.length ? { ok: true } : { ok: false, error: 'not_found' };
  }

  // ---------------------------------------------------------------- Tick

  async tick(): Promise<{ ran: boolean; log: string[] }> {
    if (this.ticking) {
      this.tickAgain = true;
      return { ran: false, log: ['tick en curso: se repetira al terminar'] };
    }
    this.ticking = true;
    const log: string[] = [];
    try {
      do {
        this.tickAgain = false;
        await this.runTick(log);
      } while (this.tickAgain);
    } catch (e) {
      console.log(`[tick] error: ${(e as Error).message}`);
      log.push(`error: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
    return { ran: true, log };
  }

  private claim(id: string, col: NotifyCol, value: number): boolean {
    return this.q(`UPDATE bookings SET ${col} = ? WHERE id = ? AND ${col} IS NULL RETURNING id`, value, id).length > 0;
  }

  /** Devuelve el aviso a la cola, o lo abandona (valor 0) tras demasiados fallos. */
  private release(id: string, col: NotifyCol) {
    const row = this.q<{ fails: string }>('SELECT fails FROM bookings WHERE id = ?', id)[0];
    let fails: Record<string, number> = {};
    try {
      fails = JSON.parse(row?.fails ?? '{}');
    } catch {
      /* vacio */
    }
    const n = (fails[col] ?? 0) + 1;
    fails[col] = n;
    const abandoned = n >= MAX_ATTEMPTS;
    this.q(`UPDATE bookings SET ${col} = ?, fails = ? WHERE id = ?`, abandoned ? 0 : null, JSON.stringify(fails), id);
    if (abandoned) console.log(`[tick] ${col} de ${id} abandonado tras ${MAX_ATTEMPTS} intentos`);
  }

  /** Reclama el aviso, lo envia y lo libera si falla. */
  private async deliver(id: string, col: NotifyCol, send: () => Promise<boolean>): Promise<boolean> {
    if (!this.claim(id, col, Date.now())) return false;
    let ok = false;
    try {
      ok = await send();
    } catch (e) {
      console.log(`[tick] ${col} de ${id}: ${(e as Error).message}`);
    }
    if (!ok) this.release(id, col);
    return ok;
  }

  private fmt(ms: number): string {
    return formatDateEs(ms, this.cfg.tzOffsetMin, this.cfg.tzLabel);
  }

  /** Aviso a Yerco: DM a cada NOTIFY_USER_IDS y, si existe, al canal. Vale con que llegue a uno. */
  private async notifyOwner(content: string): Promise<boolean> {
    let any = false;
    for (const uid of this.cfg.notifyUserIds) {
      const r = await this.discord.sendDm(uid, content, { noEmbeds: true });
      if (r.ok) any = true;
    }
    if (this.cfg.notifyChannelId) {
      const r = await this.discord.sendChannel(this.cfg.notifyChannelId, content, { noEmbeds: true });
      if (r.ok) any = true;
    }
    if (!this.cfg.notifyUserIds.length && !this.cfg.notifyChannelId) console.log('[tick] sin destinatarios de aviso');
    return any;
  }

  private describe(b: BookingRow, withNote = true): string {
    const lines = [
      `**${escapeMarkdown(b.display_name)}** (usuario: ${escapeMarkdown(b.discord_username)})`,
      `🕒 ${this.fmt(b.slot_start)}`,
    ];
    if (b.riot_id) lines.push(`🎯 Riot ID: ${escapeMarkdown(b.riot_id)}`);
    if (b.main_role) lines.push(`🛡️ Rol: ${escapeMarkdown(b.main_role)}`);
    if (withNote && b.note) lines.push(`📝 Nota: ${escapeMarkdown(b.note)}`);
    return lines.join('\n');
  }

  private async runTick(log: string[]) {
    if (!this.discord.enabled) {
      log.push('sin DISCORD_BOT_TOKEN y sin dry-run: no hay nada que hacer');
      console.log('[tick] sin DISCORD_BOT_TOKEN: se omite');
      return;
    }
    const now = Date.now();

    // 1) Avisos de reserva nueva y de cancelacion
    const fresh = this.q<BookingRow>(
      `SELECT * FROM bookings WHERE status = 'booked' AND notified_at IS NULL ORDER BY created_at`,
    );
    for (const b of fresh) {
      const ok = await this.deliver(b.id, 'notified_at', () =>
        this.notifyOwner(`📅 **Nueva primera charla agendada**\n${this.describe(b)}`),
      );
      if (ok) log.push(`aviso de reserva ${b.id}`);
    }
    const cancelled = this.q<BookingRow>(
      `SELECT * FROM bookings WHERE status = 'cancelled' AND notified_at > 0 AND cancel_notified_at IS NULL ORDER BY created_at`,
    );
    for (const b of cancelled) {
      const ok = await this.deliver(b.id, 'cancel_notified_at', () =>
        this.notifyOwner(`❌ **Charla cancelada**\n${this.describe(b, false)}`),
      );
      if (ok) log.push(`aviso de cancelacion ${b.id}`);
    }

    // 2) Sincronizar roles
    const pending = this.q<BookingRow>(
      `SELECT * FROM bookings WHERE status = 'booked' AND role_assigned_at IS NULL AND slot_start > ? ORDER BY slot_start`,
      now - 3 * HOUR,
    );
    if (pending.length) {
      const matches = await this.discord.matchMembers([...new Set(pending.map((b) => b.discord_username))]);
      log.push(`miembros emparejados: ${matches.size}/${new Set(pending.map((b) => b.discord_username)).size}`);
      for (const b of pending) {
        const uid = matches.get(b.discord_username);
        if (!uid) continue;
        const gave = await this.deliver(b.id, 'role_assigned_at', async () => {
          this.q('UPDATE bookings SET discord_user_id = ? WHERE id = ?', uid, b.id);
          const r = await this.discord.addRole(uid, `Primera charla agendada (${b.id})`);
          return r.ok;
        });
        if (gave) log.push(`rol asignado a ${b.discord_username} (${uid})`);
      }
    }
    const joined = this.q<BookingRow>(
      `SELECT * FROM bookings WHERE status = 'booked' AND role_assigned_at > 0 AND discord_user_id IS NOT NULL
         AND (role_notified_at IS NULL OR welcomed_at IS NULL) ORDER BY slot_start`,
    );
    for (const b of joined) {
      await this.deliver(b.id, 'role_notified_at', () =>
        this.notifyOwner(
          `✅ **${escapeMarkdown(b.display_name)}** (${escapeMarkdown(b.discord_username)}) entró al servidor y ya tiene ML-temp.\n🕒 ${this.fmt(b.slot_start)}`,
        ),
      );
      const ok = await this.deliver(b.id, 'welcomed_at', async () => {
        const text =
          `👋 <@${b.discord_user_id}> bienvenido a Mountain Lords. Ya tienes el rol ML-temp.\n` +
          `Tu primera charla es el ${this.fmt(b.slot_start)}. Entra a <#${this.cfg.voiceChannelId}> a esa hora; te avisamos ${this.cfg.reminderMinutes} minutos antes.`;
        const r = await this.discord.sendChannel(this.cfg.textChannelId, text, { mentionUserId: b.discord_user_id! });
        return r.ok;
      });
      if (ok) log.push(`bienvenida a ${b.discord_username}`);
    }

    // 3) Recordatorio previo a la charla
    const soon = this.q<BookingRow>(
      `SELECT * FROM bookings WHERE status = 'booked' AND slot_start > ? AND slot_start <= ? ORDER BY slot_start`,
      now,
      now + this.cfg.reminderMinutes * MIN,
    );
    for (const b of soon) {
      const inServer = (b.role_assigned_at ?? 0) > 0;
      const ok = await this.deliver(b.id, 'reminded_at', () =>
        this.notifyOwner(
          `⏰ **Charla en ${Math.max(1, Math.round((b.slot_start - now) / MIN))} min**\n${this.describe(b)}\n` +
            (inServer ? '✅ Ya está en el servidor.' : '⚠️ Aún no ha entrado al servidor.'),
        ),
      );
      if (ok) log.push(`recordatorio ${b.id}`);
      if (inServer && b.discord_user_id) {
        const pinged = await this.deliver(b.id, 'reminder_pinged_at', async () => {
          const text = `⏰ <@${b.discord_user_id}> tu charla empieza a las ${formatTime12(b.slot_start, this.cfg.tzOffsetMin)} (${this.cfg.tzLabel}). Entra a <#${this.cfg.voiceChannelId}>.`;
          return (await this.discord.sendChannel(this.cfg.textChannelId, text, { mentionUserId: b.discord_user_id! })).ok;
        });
        if (pinged) log.push(`mencion de recordatorio a ${b.discord_username}`);
      }
    }

    // 4) Agenda del dia (una vez al dia, a partir de AGENDA_HOUR)
    const today = localDateStr(now, this.cfg.tzOffsetMin);
    if (
      localMinuteOfDay(now, this.cfg.tzOffsetMin) >= this.cfg.agendaHour * 60 &&
      this.metaGet('last_agenda_date') !== today
    ) {
      const todays = this.q<BookingRow>(`SELECT * FROM bookings WHERE status = 'booked' ORDER BY slot_start`).filter(
        (b) => localDateStr(b.slot_start, this.cfg.tzOffsetMin) === today,
      );
      if (todays.length) {
        const lines = todays.map(
          (b) =>
            `• ${formatTime12(b.slot_start, this.cfg.tzOffsetMin)} — ${escapeMarkdown(b.display_name)} (${escapeMarkdown(b.discord_username)})` +
            `${b.riot_id ? ' · ' + escapeMarkdown(b.riot_id) : ''}${b.main_role ? ' · ' + escapeMarkdown(b.main_role) : ''} ` +
            `${(b.role_assigned_at ?? 0) > 0 ? '✅' : '⚠️'}`,
        );
        const head = `📋 **Charlas de hoy, ${dayShort(now, this.cfg.tzOffsetMin)}** (${this.cfg.tzLabel})`;
        const ok = await this.notifyOwner(`${head}\n${lines.join('\n')}\n✅ ya en el servidor · ⚠️ pendiente de entrar`);
        if (ok) {
          this.metaSet('last_agenda_date', today);
          log.push('agenda del dia enviada');
        }
      }
    }

    // 5) Limpieza
    this.q('DELETE FROM bookings WHERE slot_start < ?', now - 30 * DAY);
    this.q('DELETE FROM blocks WHERE slot_start < ?', now - 30 * DAY);
    this.q('DELETE FROM rate WHERE at < ?', now - 2 * DAY);
  }
}
