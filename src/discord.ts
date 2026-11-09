import type { Config } from './config';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/yercodev/ml-first-talk-appointment, 1.0)';
const MAX_CONTENT = 1900;

export interface DiscordResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  /** true si la peticion no se envio (dry-run o sin token). */
  skipped?: boolean;
}

export interface MemberRef {
  id: string;
  username: string;
}

export interface SendOptions {
  /** Id del aspirante a mencionar (unico usuario que puede recibir ping). */
  mentionUserId?: string;
  /** Suprime los embeds (flags: 4). Obligatorio si el mensaje lleva la nota. */
  noEmbeds?: boolean;
}

export interface DmCache {
  get(userId: string): string | null;
  set(userId: string, channelId: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DiscordClient {
  constructor(
    private cfg: Config,
    private token: string | undefined,
    private dmCache: DmCache,
  ) {}

  get hasToken(): boolean {
    return !!this.token;
  }

  /** Puede hacer algo util: con token, o en dry-run (que solo registra). */
  get enabled(): boolean {
    return this.hasToken || this.cfg.dryRun;
  }

  async request<T = any>(method: string, path: string, body?: unknown, reason?: string): Promise<DiscordResult<T>> {
    if (method !== 'GET' && this.cfg.dryRun) {
      console.log(`[discord dry-run] ${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
      return { ok: true, status: 0, data: null, skipped: true };
    }
    if (!this.token) {
      console.log(`[discord] sin DISCORD_BOT_TOKEN: se omite ${method} ${path}`);
      return { ok: false, status: 0, data: null, skipped: true };
    }
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      'User-Agent': USER_AGENT,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);

    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        console.log(`[discord] error de red en ${method} ${path}: ${(e as Error).message}`);
        return { ok: false, status: 0, data: null };
      }
      if (res.status === 429 && attempt === 0) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const wait = Math.min(Math.max((j.retry_after ?? 1) * 1000, 100), 8000);
        console.log(`[discord] 429 en ${method} ${path}, reintento en ${wait} ms`);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) console.log(`[discord] ${method} ${path} -> ${res.status}`);
      return { ok: res.ok, status: res.status, data };
    }
    return { ok: false, status: 429, data: null };
  }

  /** Miembros del servidor (paginado). Devuelve null si el listado no esta permitido. */
  async listMembers(): Promise<MemberRef[] | null> {
    if (!this.hasToken) return [];
    const out: MemberRef[] = [];
    let after = '0';
    for (let page = 0; page < 20; page++) {
      const r = await this.request<any[]>('GET', `/guilds/${this.cfg.guildId}/members?limit=1000&after=${after}`);
      if (r.status === 403) return null;
      if (!r.ok || !Array.isArray(r.data)) return out.length ? out : null;
      for (const m of r.data) {
        if (m?.user?.id && m.user.username) out.push({ id: m.user.id, username: String(m.user.username).toLowerCase() });
      }
      if (r.data.length < 1000) break;
      after = r.data[r.data.length - 1]?.user?.id ?? after;
    }
    return out;
  }

  async searchMember(username: string): Promise<MemberRef | null> {
    const r = await this.request<any[]>(
      'GET',
      `/guilds/${this.cfg.guildId}/members/search?query=${encodeURIComponent(username)}&limit=10`,
    );
    if (!r.ok || !Array.isArray(r.data)) return null;
    const hit = r.data.find((m) => String(m?.user?.username).toLowerCase() === username);
    return hit ? { id: hit.user.id, username } : null;
  }

  /** Empareja usernames normalizados con miembros reales. Mapa username -> id. */
  async matchMembers(usernames: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!usernames.length || !this.hasToken) return found;
    const wanted = new Set(usernames);
    const members = await this.listMembers();
    if (members) {
      for (const m of members) if (wanted.has(m.username)) found.set(m.username, m.id);
      return found;
    }
    console.log('[discord] listado de miembros no disponible (403): uso /members/search');
    for (const u of wanted) {
      const m = await this.searchMember(u);
      if (m) found.set(u, m.id);
    }
    return found;
  }

  async addRole(userId: string, reason: string): Promise<DiscordResult> {
    return this.request('PUT', `/guilds/${this.cfg.guildId}/members/${userId}/roles/${this.cfg.roleId}`, undefined, reason);
  }

  private buildMessage(content: string, opts: SendOptions) {
    const msg: Record<string, unknown> = {
      content: content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT - 1) + '…' : content,
      allowed_mentions: opts.mentionUserId ? { parse: [], users: [opts.mentionUserId] } : { parse: [] },
    };
    if (opts.noEmbeds) msg.flags = 4;
    return msg;
  }

  async sendChannel(channelId: string, content: string, opts: SendOptions = {}): Promise<DiscordResult> {
    return this.request('POST', `/channels/${channelId}/messages`, this.buildMessage(content, opts));
  }

  async sendDm(userId: string, content: string, opts: SendOptions = {}): Promise<DiscordResult> {
    let channelId = this.dmCache.get(userId);
    if (!channelId) {
      const r = await this.request<{ id: string }>('POST', '/users/@me/channels', { recipient_id: userId });
      if (!r.ok) return r;
      if (r.skipped) channelId = 'dry-run-dm';
      else {
        channelId = r.data?.id ?? null;
        if (!channelId) return { ok: false, status: r.status, data: null };
        this.dmCache.set(userId, channelId);
      }
    }
    return this.sendChannel(channelId, content, opts);
  }
}
