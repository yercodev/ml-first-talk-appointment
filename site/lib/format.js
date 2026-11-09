// Formato de fechas en la zona de la agenda (no la del navegador). Sin dependencias.
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DAYS_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function localParts(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** "5:10 PM" */
export function time12(ms, offsetMin) {
  const p = localParts(ms, offsetMin);
  const h = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** "4:30 PM – 5:10 PM" */
export function range(ms, slotMinutes, offsetMin) {
  return `${time12(ms, offsetMin)} – ${time12(ms + slotMinutes * 60000, offsetMin)}`;
}

/** "martes 10 de nov" */
export function longDate(ms, offsetMin) {
  const p = localParts(ms, offsetMin);
  return `${DAYS_LONG[p.wd]} ${p.d} de ${MONTHS[p.mo]}`;
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
