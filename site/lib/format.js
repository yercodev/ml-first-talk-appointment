// Formato de fechas en la zona de la agenda (no la del navegador). Sin dependencias.
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAYS_SHORT_LOWER = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS_LONG = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const NBSP = ' ';

export function localParts(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** "5:10 PM" (con espacio de no separacion, para que la hora no se parta entre dos lineas) */
export function time12(ms, offsetMin) {
  const p = localParts(ms, offsetMin);
  const h = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h}:${String(p.mi).padStart(2, '0')}${NBSP}${p.h < 12 ? 'AM' : 'PM'}`;
}

/** "4:30 PM – 5:10 PM" */
export function range(ms, slotMinutes, offsetMin) {
  return `${time12(ms, offsetMin)} – ${time12(ms + slotMinutes * 60000, offsetMin)}`;
}

/** "Martes 10 de noviembre" */
export function longDate(ms, offsetMin) {
  const p = localParts(ms, offsetMin);
  return `${DAYS_LONG[p.wd]} ${p.d} de ${MONTHS[p.mo]}`;
}

/** "vie 13" */
export function weekdayDay(ms, offsetMin) {
  const p = localParts(ms, offsetMin);
  return `${DAYS_SHORT_LOWER[p.wd]} ${p.d}`;
}

/** Fecha local de la agenda "YYYY-MM-DD" de un instante. */
export function localDate(ms, offsetMin) {
  return new Date(ms + offsetMin * 60000).toISOString().slice(0, 10);
}

/** "Hoy", "Mañana" o "Lun 10". */
export function dayLabel(dateStr, nowMs, offsetMin) {
  const today = localDate(nowMs, offsetMin);
  const diff = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** "-05:00" -> -300 */
export function offsetMinutes(text) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(text || '');
  if (!m) return -300;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Hora en la zona del visitante cuando es distinta a la de la agenda; si no, null.
 * { time: "6:10 PM", day: null | "vie 13" } (day solo si cambia el dia respecto a Colombia)
 */
export function visitorLocal(ms, agendaOffset, visitorOffset) {
  if (visitorOffset === agendaOffset) return null;
  const sameDay = localDate(ms, visitorOffset) === localDate(ms, agendaOffset);
  return { time: time12(ms, visitorOffset), day: sameDay ? null : weekdayDay(ms, visitorOffset) };
}

/** "(hora Colombia)" o "(hora Colombia; en tu hora, 6:10 PM)" o "(hora Colombia; en tu hora, vie 13, 1:10 AM)" */
export function colombiaSuffix(ms, agendaOffset, visitorOffset) {
  const v = visitorLocal(ms, agendaOffset, visitorOffset);
  if (!v) return '(hora Colombia)';
  return `(hora Colombia; en tu hora, ${v.day ? v.day + ', ' : ''}${v.time})`;
}

/** "domingo 15 de noviembre" (minuscula: para mitad de frase) a partir de "2026-11-15". Sale de bookingUntil, nunca escrito a mano. */
export function dateMid(dateStr) {
  const ms = Date.parse(`${dateStr}T12:00:00Z`);
  const long = longDate(ms, 0);
  return long.charAt(0).toLowerCase() + long.slice(1);
}

/** Chip mientras haya fecha de cierre (sin punto, como los demas chips). */
export const chipUntilText = (dateStr) => `Charlas hasta el ${dateMid(dateStr)}`;

/** Convocatoria cerrada: titular y lineas. */
export const CLOSED_TITLE = 'La convocatoria cerró';
export const closedLine1 = (dateStr) => `Las charlas del proceso fueron hasta el ${dateMid(dateStr)}.`;
export const CLOSED_LINE2_BEFORE = 'Si te postulaste y no alcanzaste a reservar, escríbele a Yerco en ';
export const CLOSED_LINE2_LINK = 'YercoVerse';

/** Sin cupos libres antes del cierre. */
export const noSlotsBefore = (dateStr) => `Ya no quedan horarios libres: el último día de charlas es el ${dateMid(dateStr)}. `;
