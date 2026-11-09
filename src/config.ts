export interface Env {
  AGENDA: DurableObjectNamespace<import('./agenda').Agenda>;
  ASSETS: Fetcher;
  // secrets
  DISCORD_BOT_TOKEN?: string;
  ADMIN_TOKEN?: string;
  IP_SALT?: string;
  // vars
  TZ_OFFSET_MIN: string;
  TZ_LABEL: string;
  FIRST_SLOT_HOUR: string;
  FIRST_SLOT_MINUTE: string;
  SLOT_MINUTES: string;
  SLOTS_PER_DAY: string;
  WINDOW_DAYS: string;
  MIN_LEAD_MINUTES: string;
  REMINDER_MINUTES: string;
  AGENDA_HOUR: string;
  DISCORD_GUILD_ID: string;
  DISCORD_ROLE_ID: string;
  DISCORD_TEXT_CHANNEL_ID: string;
  DISCORD_VOICE_CHANNEL_ID: string;
  DISCORD_INVITE_URL: string;
  NOTIFY_USER_IDS: string;
  NOTIFY_CHANNEL_ID?: string;
  DISCORD_DRY_RUN: string;
}

export interface Config {
  tzOffsetMin: number;
  tzLabel: string;
  firstSlotMinutes: number; // minutos desde medianoche local
  slotMinutes: number;
  slotsPerDay: number;
  windowDays: number;
  minLeadMinutes: number;
  reminderMinutes: number;
  agendaHour: number;
  guildId: string;
  roleId: string;
  textChannelId: string;
  voiceChannelId: string;
  inviteUrl: string;
  notifyUserIds: string[];
  notifyChannelId: string;
  dryRun: boolean;
}

function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env: Env): Config {
  return {
    tzOffsetMin: int(env.TZ_OFFSET_MIN, -300),
    tzLabel: env.TZ_LABEL || 'hora Colombia',
    firstSlotMinutes: int(env.FIRST_SLOT_HOUR, 16) * 60 + int(env.FIRST_SLOT_MINUTE, 30),
    slotMinutes: int(env.SLOT_MINUTES, 40),
    slotsPerDay: int(env.SLOTS_PER_DAY, 9),
    windowDays: int(env.WINDOW_DAYS, 14),
    minLeadMinutes: int(env.MIN_LEAD_MINUTES, 60),
    reminderMinutes: int(env.REMINDER_MINUTES, 15),
    agendaHour: int(env.AGENDA_HOUR, 16),
    guildId: env.DISCORD_GUILD_ID,
    roleId: env.DISCORD_ROLE_ID,
    textChannelId: env.DISCORD_TEXT_CHANNEL_ID,
    voiceChannelId: env.DISCORD_VOICE_CHANNEL_ID,
    inviteUrl: env.DISCORD_INVITE_URL,
    notifyUserIds: (env.NOTIFY_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    notifyChannelId: (env.NOTIFY_CHANNEL_ID || '').trim(),
    dryRun: env.DISCORD_DRY_RUN === '1' || env.DISCORD_DRY_RUN === 'true',
  };
}
