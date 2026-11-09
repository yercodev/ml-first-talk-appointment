import { rpc, isConfigured, refuseFraming } from './lib/api.js';
import * as fmt from './lib/format.js';

refuseFraming();

const $ = (id) => document.getElementById(id);
const KEY = 'ml-admin-key';
let OFFSET = -300;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) node.append(c);
  return node;
}

const getKey = () => {
  try {
    return sessionStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};
const setKey = (v) => {
  try {
    v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento: la clave solo vive en memoria */
  }
};

const ms = (iso) => Date.parse(iso);
const time = (iso) => fmt.time12(ms(iso), OFFSET);
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dayTitle = (date) => {
  const d = new Date(date + 'T12:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

// Tipos de aviso legibles para Yerco
const KIND_LABEL = {
  new: 'DM nueva charla',
  joined: 'DM ya tiene ML-temp',
  welcome: 'Bienvenida en #ml-temp',
  'reminder-dm': 'DM 15 min',
  'reminder-ch': 'Aviso 15 min en #ml-temp',
  cancel: 'DM cancelación',
  agenda: 'DM agenda del día',
};

function show(loggedIn) {
  $('login').hidden = loggedIn;
  $('panel').hidden = !loggedIn;
}
const setStatus = (t) => ($('status').textContent = t);

async function act(fn, args, confirmText, after) {
  if (confirmText && !confirm(confirmText)) return;
  const r = await rpc(fn, { p_key: getKey(), ...args });
  const d = r.data || {};
  if (d.code === 'slot_booked') setStatus('Ese horario tiene una charla. Cancélala primero si quieres bloquearlo.');
  else if (d.code) setStatus(d.message || 'No se pudo completar la acción.');
  else if (after) setStatus(after(d));
  await load(false);
}

function renderBooked(s) {
  const b = s.booking;
  const box = el('div', { class: 'aslot booked' });
  const head = el('div', { class: 'head' }, el('span', { class: 'time' }, `${time(s.start)} – ${time(s.end)}`));
  head.append(el('span', { class: 'badge blue' }, 'Reservado'));
  head.append(
    el('span', { class: b.inServer ? 'badge ok' : 'badge warn' }, b.inServer ? `Con ML-temp${b.roleAssignedAt ? ' · ' + time(b.roleAssignedAt) : ''}` : 'Sin ML-temp aún'),
  );
  box.append(head);
  const who = el('div', { class: 'who' }, el('strong', {}, `${b.displayName} · ${b.discordUsername}`));
  const extra = [b.riotId && `Riot ID: ${b.riotId}`, b.mainRole && `Rol: ${b.mainRole}`].filter(Boolean).join(' · ');
  if (extra) who.append(el('span', {}, extra));
  if (b.message) who.append(el('span', { class: 'note' }, b.message)); // textContent: nunca HTML
  box.append(who);
  box.append(
    el(
      'div',
      { class: 'acts' },
      el('button', { class: 'mini danger', type: 'button', onclick: () => act('ml_admin_cancel', { p_booking_id: b.id }, `¿Cancelar la charla de ${b.displayName}? El bot no le avisa: si hace falta, escríbele tú.`, () => 'Charla cancelada.') }, 'Cancelar'),
    ),
  );
  return box;
}

function renderChip(s) {
  const t = time(s.start);
  if (s.state === 'blocked') {
    return el('button', { class: 'chip blocked', type: 'button', title: 'Bloqueado: pulsa para desbloquear', onclick: () => act('ml_admin_unblock', { p_slot_start: s.start }) }, `${t} · bloqueado`);
  }
  if (s.past) return el('span', { class: 'chip past' }, t);
  return el('button', { class: 'chip', type: 'button', title: 'Libre: pulsa para bloquear', onclick: () => act('ml_admin_block', { p_slot_start: s.start }) }, `${t} · libre`);
}

function renderIntegration(d) {
  const alert = $('n8n-alert');
  const last = d.lastIntegrationRunAt ? ms(d.lastIntegrationRunAt) : null;
  const now = ms(d.now);
  if (!last) {
    $('n8n-status').textContent = 'n8n: todavía no se ha ejecutado.';
    alert.hidden = false;
    alert.textContent = 'Los roles y avisos están detenidos: n8n no se ha ejecutado todavía.';
  } else {
    const mins = Math.max(0, Math.round((now - last) / 60000));
    $('n8n-status').textContent = `n8n: última ejecución hace ${mins} min`;
    alert.hidden = mins <= 5;
    if (mins > 5) alert.textContent = `Los roles y avisos están detenidos: n8n no responde desde las ${time(d.lastIntegrationRunAt)}.`;
  }
  const failed = $('failed');
  failed.hidden = d.failedNotifications.length === 0;
  failed.replaceChildren();
  if (d.failedNotifications.length) {
    failed.append(el('strong', {}, `${d.failedNotifications.length} ${d.failedNotifications.length === 1 ? 'aviso no se pudo enviar' : 'avisos no se pudieron enviar'}`));
    for (const n of d.failedNotifications) failed.append(el('div', {}, `${KIND_LABEL[n.kind] || n.kind} · ${time(n.at)}${n.error ? ' · ' + n.error : ''}`));
  }
}

async function load(resetStatus = true) {
  const r = await rpc('ml_admin_agenda', { p_key: getKey() });
  const d = r.data || {};
  if (r.status === 401 || d.code === 'unauthorized') {
    setKey('');
    show(false);
    $('login-err').textContent = 'Clave incorrecta';
    return;
  }
  if (d.code === 'rate_limited') {
    setKey('');
    show(false);
    $('login-err').textContent = 'Demasiados intentos. Espera 15 minutos.';
    return;
  }
  if (!r.ok || !d.days) {
    show(true);
    setStatus(d.message || 'No se pudo cargar la agenda.');
    return;
  }
  show(true);
  OFFSET = fmt.offsetMinutes(d.utcOffset);
  const box = $('agenda');
  box.replaceChildren();
  let total = 0;
  for (const day of d.days) {
    const booked = day.slots.filter((s) => s.state === 'booked').length;
    total += booked;
    const title = el('h2', {}, dayTitle(day.date), el('small', {}, booked ? `${booked} charla${booked > 1 ? 's' : ''}` : 'sin charlas'));
    const blockMsg = (x) =>
      `Cupos bloqueados: ${x.blocked}.` + (x.skippedBooked ? (x.skippedBooked === 1 ? ' Queda 1 charla ese día.' : ` Quedan ${x.skippedBooked} charlas ese día.`) : '');
    const dayActs = el(
      'div',
      { class: 'acts day-acts' },
      el('button', { class: 'mini', type: 'button', onclick: () => act('ml_admin_block', { p_date: day.date }, null, blockMsg) }, 'Bloquear el día'),
      el('button', { class: 'mini', type: 'button', onclick: () => act('ml_admin_unblock', { p_date: day.date }) }, 'Desbloquear el día'),
    );
    const sec = el('section', { class: 'dayblock' }, title, dayActs);
    for (const s of day.slots) if (s.state === 'booked' && s.booking) sec.append(renderBooked(s));
    const chips = el('div', { class: 'chips-row' });
    for (const s of day.slots) if (s.state !== 'booked' && !(s.past && s.state === 'free')) chips.append(renderChip(s));
    if (chips.children.length) sec.append(chips);
    box.append(sec);
  }
  if (d.bookingUntil) {
    const longDay = fmt.longDate(Date.parse(`${d.bookingUntil}T12:00:00Z`), 0);
    $('until-status').textContent = `Convocatoria abierta hasta el ${longDay.charAt(0).toLowerCase()}${longDay.slice(1)} (incluido).`;
  } else {
    $('until-status').textContent = 'Convocatoria sin fecha de cierre.';
  }
  renderIntegration(d);
  if (resetStatus) setStatus(`${total} charla${total === 1 ? '' : 's'} agendada${total === 1 ? '' : 's'} · hora Colombia`);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  setKey($('key').value.trim());
  $('key').value = '';
  await load();
});
$('refresh').addEventListener('click', () => load());
$('logout').addEventListener('click', () => {
  setKey('');
  show(false);
});

if (!isConfigured()) {
  $('login-err').textContent = 'La agenda aún no está configurada (falta la clave anon en config.js).';
} else {
  if (getKey()) load();
  setInterval(() => {
    if (getKey() && !document.hidden) load(false);
  }, 60000);
}
