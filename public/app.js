const $ = (id) => document.getElementById(id);
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DAYS_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const state = { data: null, day: null, slot: null };

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

// ---- Fechas (siempre en la zona de la agenda, no la del navegador)
function tzOffset() {
  return state.data?.timezone.offsetMinutes ?? -300;
}
function localParts(ms) {
  const d = new Date(ms + tzOffset() * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function time12(ms) {
  const p = localParts(ms);
  const h = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}
function range(start) {
  return `${time12(start)} – ${time12(start + state.data.slotMinutes * 60000)}`;
}
function longDate(ms) {
  const p = localParts(ms);
  return `${DAYS_LONG[p.wd]} ${p.d} de ${MONTHS[p.mo]}`;
}
function visitorTime(ms) {
  if (-new Date(ms).getTimezoneOffset() === tzOffset()) return null;
  return new Date(ms).toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
}
function todayStr() {
  return new Date(Date.now() + tzOffset() * 60000).toISOString().slice(0, 10);
}
function dayLabel(dateStr) {
  const today = todayStr();
  const diff = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

// ---- API
async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function loadSlots() {
  const r = await api('/api/slots');
  if (!r.ok) throw new Error('slots');
  state.data = r.data;
  const inv = $('invite');
  if (inv && r.data.inviteUrl) inv.href = r.data.inviteUrl;
}

// ---- Render: dias, horas, formulario
function freeCount(day) {
  return day.slots.filter((s) => s.status === 'free').length;
}

function renderDays() {
  const box = $('days');
  box.replaceChildren();
  if (!state.data.days.length) {
    box.append(el('p', { class: 'loading' }, 'No hay horarios disponibles por ahora. Vuelve a intentarlo más tarde.'));
    return;
  }
  for (const day of state.data.days) {
    const n = freeCount(day);
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'day',
        'aria-pressed': String(state.day === day.date),
        disabled: n === 0,
        onclick: () => selectDay(day.date),
      },
      el('span', { class: 'd' }, dayLabel(day.date)),
      el('span', { class: 'n' }, n === 0 ? 'Sin cupos' : n === 1 ? '1 cupo' : `${n} cupos`),
    );
    box.append(btn);
  }
}

function selectDay(date, keepSlot = false) {
  state.day = date;
  if (!keepSlot) state.slot = null;
  renderDays();
  renderSlots();
  $('step-form').hidden = !state.slot;
}

function renderSlots() {
  const day = state.data.days.find((d) => d.date === state.day);
  $('step-time').hidden = !day;
  if (!day) return;
  const label = state.data.timezone.label;
  const first = day.slots[0];
  const other = first && visitorTime(first.start);
  $('tz-note').textContent = other
    ? `Horarios en ${label}. Tu navegador está en otra zona: mostramos tu hora debajo de cada cupo.`
    : `Horarios en ${label}.`;
  const box = $('slots');
  box.replaceChildren();
  for (const s of day.slots) {
    const mine = visitorTime(s.start);
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'slot',
        disabled: s.status !== 'free',
        'aria-pressed': String(state.slot === s.start),
        onclick: () => selectSlot(s.start),
      },
      el('span', { class: 't' }, range(s.start)),
    );
    if (mine) btn.append(el('span', { class: 'l' }, `Tu hora: ${mine}`));
    else if (s.status !== 'free') btn.append(el('span', { class: 'l' }, 'Ocupado'));
    box.append(btn);
  }
}

function selectSlot(start) {
  state.slot = start;
  renderSlots();
  const sum = $('summary');
  sum.replaceChildren(
    document.createTextNode(`${longDate(start)} · ${range(start)} `),
    el('span', { class: 'muted' }, `(${state.data.timezone.label})`),
  );
  const wasHidden = $('step-form').hidden;
  $('step-form').hidden = false;
  clearErrors();
  if (wasHidden) $('step-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Formulario
const FIELD_IDS = { discord: 'discord', name: 'name', riotId: 'riotId', note: 'note' };

function clearErrors() {
  for (const id of ['discord', 'name', 'riotId', 'note']) {
    $(`${id}-err`).textContent = '';
    $(id).removeAttribute('aria-invalid');
  }
  $('form-err').textContent = '';
}

function showError(field, message) {
  if (FIELD_IDS[field]) {
    $(`${field}-err`).textContent = message;
    $(field).setAttribute('aria-invalid', 'true');
    $(field).focus();
  } else {
    $('form-err').textContent = message;
  }
}

async function submitBooking(ev) {
  ev.preventDefault();
  clearErrors();
  if (!state.slot) return showError('form', 'Elige primero un horario.');
  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Agendando…';
  const body = {
    slotStart: state.slot,
    discord: $('discord').value,
    name: $('name').value,
    riotId: $('riotId').value,
    role: $('role').value,
    note: $('note').value,
    website: $('website').value,
  };
  try {
    const r = await api('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return showDone(r.data);
    if (r.status === 400 && r.data.error === 'validation') return showError(r.data.field, r.data.message);
    if (r.status === 409 && r.data.error === 'slot_taken') {
      state.slot = null;
      await loadSlots();
      selectDay(state.day);
      $('step-form').hidden = true;
      $('slots').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('tz-note').textContent = '';
      $('tz-note').append(el('span', { class: 'notice' }, 'Alguien acaba de tomar ese horario. Hemos actualizado los cupos: elige otro.'));
      return;
    }
    if (r.status === 400 && r.data.error === 'invalid_slot') {
      state.slot = null;
      await loadSlots();
      selectDay(state.day);
    }
    showError('form', r.data.message || 'No pudimos agendar tu charla. Inténtalo de nuevo.');
  } catch {
    showError('form', 'No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar mi charla';
  }
}

function showDone(data) {
  $('booking-flow').hidden = true;
  $('view-done').hidden = false;
  $('done-when').textContent = `${longDate(data.slotStart)} · ${range(data.slotStart)} (${state.data.timezone.label})`;
  $('cancel-link').value = `${location.origin}/?cancelar=${data.id}.${data.cancelToken}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function copyLink() {
  const input = $('cancel-link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  const b = $('copy');
  b.textContent = '¡Copiado!';
  setTimeout(() => (b.textContent = 'Copiar'), 1800);
}

// ---- Cancelar
function showCancel(param) {
  const dot = param.indexOf('.');
  const id = dot > 0 ? param.slice(0, dot) : '';
  const token = dot > 0 ? param.slice(dot + 1) : '';
  $('booking-flow').hidden = true;
  $('view-cancel').hidden = false;
  if (!id || !token) {
    $('cancel-title').textContent = 'Enlace no válido';
    $('cancel-text').textContent = 'Este enlace de cancelación está incompleto. Usa el enlace completo que te dimos al agendar.';
    $('cancel-yes').hidden = true;
    $('cancel-no').textContent = 'Agendar una charla';
    return;
  }
  $('cancel-yes').addEventListener('click', async () => {
    const b = $('cancel-yes');
    b.disabled = true;
    b.textContent = 'Cancelando…';
    try {
      const r = await api('/api/bookings/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, token }),
      });
      b.hidden = true;
      $('cancel-no').textContent = 'Agendar otra charla';
      if (r.ok) {
        $('cancel-title').textContent = 'Charla cancelada';
        $('cancel-text').textContent = 'Listo, cancelamos tu charla y el horario quedó libre. Cuando quieras, agenda otra.';
      } else {
        $('cancel-title').textContent = 'No encontramos tu charla';
        $('cancel-text').textContent = r.data.message || 'El enlace no es válido o la charla ya estaba cancelada.';
      }
    } catch {
      b.disabled = false;
      b.textContent = 'Sí, cancelar mi charla';
      $('cancel-text').textContent = 'No hay conexión con el servidor. Inténtalo de nuevo.';
    }
  });
}

// ---- Arranque
async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('cancelar')) {
    showCancel(params.get('cancelar') || '');
    return;
  }
  $('form').addEventListener('submit', submitBooking);
  $('copy').addEventListener('click', copyLink);
  $('note').addEventListener('input', () => {
    $('note-count').textContent = `${$('note').value.length} / 300`;
  });
  $('days').append(el('p', { class: 'loading' }, 'Cargando horarios…'));
  try {
    await loadSlots();
  } catch {
    $('days').replaceChildren(el('p', { class: 'notice' }, 'No pudimos cargar los horarios. Recarga la página en unos segundos.'));
    return;
  }
  const firstFree = state.data.days.find((d) => freeCount(d) > 0);
  renderDays();
  if (firstFree) selectDay(firstFree.date);
}

init();
