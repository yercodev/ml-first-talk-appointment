import { localMinuteOfDay, pad2 } from './slots';

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function dayShort(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "5:10 PM" */
export function formatTime12(ms: number, tzOffsetMin: number): string {
  const m = localMinuteOfDay(ms, tzOffsetMin);
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad2(m % 60)} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "sáb 8 nov · 5:10 PM (hora Colombia)" */
export function formatDateEs(ms: number, tzOffsetMin: number, tzLabel: string): string {
  return `${dayShort(ms, tzOffsetMin)} · ${formatTime12(ms, tzOffsetMin)} (${tzLabel})`;
}

/** Escapa el markdown de Discord en textos que vienen del usuario. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>#[\]()<@:]/g, (c) => '\\' + c);
}
