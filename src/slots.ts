import type { Config } from './config';

const MIN = 60_000;
const DAY_MIN = 1440;

type SlotCfg = Pick<
  Config,
  'tzOffsetMin' | 'firstSlotMinutes' | 'slotMinutes' | 'slotsPerDay' | 'windowDays' | 'minLeadMinutes'
>;

export interface Slot {
  start: number; // ms UTC
  end: number;
  time: string; // HH:MM hora local de la agenda
}

export interface Day {
  date: string; // YYYY-MM-DD (local de la agenda)
  slots: Slot[];
}

/** Medianoche local de la fecha local de `nowMs`, expresada en ms UTC. */
export function localMidnightUtc(nowMs: number, tzOffsetMin: number): number {
  const localMs = nowMs + tzOffsetMin * MIN;
  const d = new Date(localMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOffsetMin * MIN;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" de un instante en la zona de la agenda. */
export function localDateStr(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * MIN);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Minutos desde la medianoche local. */
export function localMinuteOfDay(ms: number, tzOffsetMin: number): number {
  const d = new Date(ms + tzOffsetMin * MIN);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function formatHHMM(ms: number, tzOffsetMin: number): string {
  const m = localMinuteOfDay(ms, tzOffsetMin);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Todos los cupos de la ventana (sin filtrar por antelacion). */
export function generateDays(nowMs: number, cfg: SlotCfg): Day[] {
  const base = localMidnightUtc(nowMs, cfg.tzOffsetMin);
  const days: Day[] = [];
  for (let d = 0; d < cfg.windowDays; d++) {
    const dayStart = base + d * DAY_MIN * MIN;
    const slots: Slot[] = [];
    for (let i = 0; i < cfg.slotsPerDay; i++) {
      const start = dayStart + (cfg.firstSlotMinutes + i * cfg.slotMinutes) * MIN;
      slots.push({
        start,
        end: start + cfg.slotMinutes * MIN,
        time: formatHHMM(start, cfg.tzOffsetMin),
      });
    }
    days.push({ date: localDateStr(dayStart + 12 * 60 * MIN, cfg.tzOffsetMin), slots });
  }
  return days;
}

/** Cupos reservables: dentro de la ventana y con la antelacion minima. */
export function bookableDays(nowMs: number, cfg: SlotCfg): Day[] {
  const limit = nowMs + cfg.minLeadMinutes * MIN;
  return generateDays(nowMs, cfg)
    .map((day) => ({ ...day, slots: day.slots.filter((s) => s.start >= limit) }))
    .filter((day) => day.slots.length > 0);
}

export function isBookableSlot(start: number, nowMs: number, cfg: SlotCfg): boolean {
  if (!Number.isFinite(start)) return false;
  return bookableDays(nowMs, cfg).some((d) => d.slots.some((s) => s.start === start));
}
