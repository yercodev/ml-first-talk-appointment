const $ = (id) => document.getElementById(id);
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const KEY = 'ml-admin-key';
let timer = null;

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

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${getKey()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function time12(ms, off) {
  const d = new Date(ms + off * 60000);
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function dayTitle(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function show(loggedIn) {
  $('login').hidden = loggedIn;
  $('panel').hidden = !loggedIn;
}

function setStatus(text) {
  $('status').textContent = text;
}

async function act(path, method, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  const r = await api(path, method, body);
  if (!r.ok) setStatus(r.data.message || `Error ${r.status}`);
  await load();
}

function renderSlot(s, off, slotMs) {
  const cls = ['aslot', s.status, s.past ? 'past' : ''].join(' ').trim();
  const head = el('div', { class: 'head' }, el('span', { class: 'time' }, `${time12(s.start, off)} – ${time12(s.start + slotMs, off)}`));
  const box = el('div', { class: cls }, head);

  if (s.status === 'booked' && s.booking) {
    const b = s.booking;
    head.append(el('span', { class: 'badge blue' }, 'Reservado'));
    head.append(el('span', { class: b.inServer ? 'badge ok' : 'badge warn' }, b.inServer ? 'en el servidor ✓' : 'pendiente de entrar'));
    const who = el('div', { class: 'who' }, el('strong', {}, `${b.name} · @${b.discord}`));
    const extra = [b.riotId && `Riot: ${b.riotId}`, b.role && `Rol: ${b.role}`].filter(Boolean).join(' · ');
    if (extra) who.append(el('span', {}, extra));
    if (b.note) who.append(el('span', { class: 'note' }, `“${b.note}”`));
    box.append(who);
    box.append(
      el('div', { class: 'acts' }, el('button', { class: 'mini danger', type: 'button', onclick: () => act(`/api/admin/bookings/${b.id}/cancel`, 'POST', null, `¿Cancelar la charla de ${b.name}?`) }, 'Cancelar reserva')),
    );
  } else if (s.status === 'blocked') {
    head.append(el('span', { class: 'badge' }, 'Bloqueado'));
    box.append(el('div', { class: 'acts' }, el('button', { class: 'mini', type: 'button', onclick: () => act(`/api/admin/blocks/${s.start}`, 'DELETE') }, 'Desbloquear')));
  } else {
    head.append(el('span', { class: 'badge ok' }, s.past ? 'Pasado' : 'Libre'));
    if (!s.past) box.append(el('div', { class: 'acts' }, el('button', { class: 'mini', type: 'button', onclick: () => act('/api/admin/blocks', 'POST', { slotStart: s.start }) }, 'Bloquear')));
  }
  return box;
}

async function load() {
  const r = await api('/api/admin/agenda');
  if (r.status === 401) {
    setKey('');
    show(false);
    $('login-err').textContent = 'Clave incorrecta.';
    return;
  }
  if (!r.ok) {
    show(true);
    setStatus(r.data.message || `Error ${r.status}`);
    return;
  }
  show(true);
  const { days, timezone, now } = r.data;
  const slotMs = days[0] && days[0].slots[0] ? (days[0].slots[1] ? days[0].slots[1].start - days[0].slots[0].start : 2400000) : 2400000;
  const box = $('agenda');
  box.replaceChildren();
  let total = 0;
  for (const day of days) {
    const booked = day.slots.filter((s) => s.status === 'booked').length;
    total += booked;
    const sec = el('section', { class: 'dayblock' }, el('h2', {}, dayTitle(day.date), el('small', {}, booked ? `${booked} charla${booked > 1 ? 's' : ''}` : 'sin charlas')));
    for (const s of day.slots) if (!(s.past && s.status === 'free')) sec.append(renderSlot(s, timezone.offsetMinutes, slotMs));
    box.append(sec);
  }
  setStatus(`${total} charla${total === 1 ? '' : 's'} agendada${total === 1 ? '' : 's'} · ${timezone.label} · actualizado ${time12(now, timezone.offsetMinutes)}`);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  setKey($('key').value.trim());
  $('key').value = '';
  await load();
});
$('refresh').addEventListener('click', load);
$('logout').addEventListener('click', () => {
  setKey('');
  show(false);
});
$('run-tick').addEventListener('click', async () => {
  const r = await api('/api/admin/tick', 'POST');
  setStatus(r.ok ? `Avisos: ${r.data.log.length ? r.data.log.join(' · ') : 'nada pendiente'}` : r.data.message || `Error ${r.status}`);
  await load();
});

if (getKey()) load();
timer = setInterval(() => {
  if (getKey() && !document.hidden) load();
}, 60000);
