import { rpc, isConfigured } from './lib/api.js';
import * as fmt from './lib/format.js';

const $ = (id) => document.getElementById(id);
const state = { data: null, day: null, slot: null, offset: -300 };

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
const ms = (iso) => Date.parse(iso);
const time12 = (iso) => fmt.time12(ms(iso), state.offset);
const range = (slot) => `${time12(slot.start)} – ${time12(slot.end)}`;
const longDate = (iso) => fmt.longDate(ms(iso), state.offset);
const dayLabel = (dateStr) => fmt.dayLabel(dateStr, ms(state.data.now), state.offset);
function visitorTime(iso) {
  if (-new Date(ms(iso)).getTimezoneOffset() === state.offset) return null;
  return new Date(ms(iso)).toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
}

async function loadSlots() {
  const r = await rpc('ml_slots');
  if (!r.ok || !r.data.days) throw new Error('slots');
  state.data = r.data;
  state.offset = fmt.offsetMinutes(r.data.utcOffset);
  if (r.data.inviteUrl) $('invite').href = r.data.inviteUrl;
}

// ---- Dias, horas y formulario
const freeCount = (day) => day.slots.filter((s) => s.available).length;

function renderDays() {
  const box = $('days');
  box.replaceChildren();
  if (!state.data.days.some((d) => freeCount(d) > 0)) {
    box.append(el('p', { class: 'loading' }, 'No quedan horarios libres en los próximos 14 días. Vuelve mañana.'));
    return;
  }
  for (const day of state.data.days) {
    const n = freeCount(day);
    box.append(
      el(
        'button',
        { type: 'button', class: 'day', 'aria-pressed': String(state.day === day.date), disabled: n === 0, onclick: () => selectDay(day.date) },
        el('span', { class: 'd' }, dayLabel(day.date)),
        el('span', { class: 'n' }, n === 0 ? 'No disponible' : n === 1 ? '1 cupo' : `${n} cupos`),
      ),
    );
  }
}

function selectDay(date) {
  state.day = date;
  state.slot = null;
  renderDays();
  renderSlots();
  $('step-form').hidden = true;
}

function renderSlots() {
  const day = state.data.days.find((d) => d.date === state.day);
  $('step-time').hidden = !day;
  if (!day) return;
  const other = day.slots[0] && visitorTime(day.slots[0].start);
  $('tz-note').textContent = other
    ? 'Horarios en hora Colombia. Tu navegador está en otra zona: mostramos tu hora debajo de cada cupo.'
    : 'Horarios en hora Colombia.';
  const box = $('slots');
  box.replaceChildren();
  for (const s of day.slots) {
    const mine = visitorTime(s.start);
    const btn = el(
      'button',
      { type: 'button', class: 'slot', disabled: !s.available, 'aria-pressed': String(state.slot === s.start), onclick: () => selectSlot(s) },
      el('span', { class: 't' }, range(s)),
    );
    if (!s.available) btn.append(el('span', { class: 'l' }, 'No disponible'));
    else if (mine) btn.append(el('span', { class: 'l' }, `Tu hora: ${mine}`));
    box.append(btn);
  }
}

function selectSlot(s) {
  state.slot = s.start;
  renderSlots();
  $('summary').replaceChildren(
    document.createTextNode(`${longDate(s.start)} · ${range(s)} `),
    el('span', { class: 'muted' }, '(hora Colombia)'),
  );
  const wasHidden = $('step-form').hidden;
  $('step-form').hidden = false;
  clearErrors();
  if (wasHidden) $('step-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Formulario
const FIELDS = ['discordUsername', 'displayName', 'riotId', 'message', 'privacyAccepted'];

function clearErrors() {
  for (const id of FIELDS) {
    $(`${id}-err`).textContent = '';
    $(id).removeAttribute('aria-invalid');
  }
  $('form-err').textContent = '';
}

function showFieldErrors(details) {
  let focused = false;
  for (const [field, message] of Object.entries(details || {})) {
    if (!FIELDS.includes(field)) {
      $('form-err').textContent = message;
      continue;
    }
    $(`${field}-err`).textContent = message;
    $(field).setAttribute('aria-invalid', 'true');
    if (!focused) {
      $(field).focus();
      focused = true;
    }
  }
}

const formError = (message) => ($('form-err').textContent = message);

async function refreshAfterConflict(message) {
  state.slot = null;
  await loadSlots();
  selectDay(state.day);
  $('slots').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('tz-note').replaceChildren(el('span', { class: 'notice' }, message));
}

async function submitBooking(ev) {
  ev.preventDefault();
  clearErrors();
  if (!state.slot) return formError('Elige primero un horario.');
  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Reservando…';
  try {
    const r = await rpc('ml_book', {
      p_slot_start: state.slot,
      p_discord_username: $('discordUsername').value,
      p_display_name: $('displayName').value,
      p_riot_id: $('riotId').value,
      p_main_role: $('mainRole').value,
      p_message: $('message').value,
      p_privacy_accepted: $('privacyAccepted').checked,
      p_website: $('website').value,
    });
    const d = r.data || {};
    if (r.ok && d.booking) return showDone(d);
    if (r.status === 0) return formError('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
    if (d.code === 'validation_error') return showFieldErrors(d.details);
    if (d.code === 'slot_taken') return await refreshAfterConflict('Alguien acaba de tomar ese horario. Elige otro.');
    if (d.code === 'slot_not_bookable') return await refreshAfterConflict('Ese horario ya no se puede reservar. Elige otro.');
    if (d.code === 'already_booked') {
      return formError('Ese usuario de Discord ya tiene una charla agendada. Si es tuya y quieres cambiarla, cancélala con tu enlace y vuelve a reservar.');
    }
    if (d.code === 'rate_limited') return formError('Hoy ya se hicieron demasiadas reservas desde esta conexión. Inténtalo mañana o escríbenos en YercoVerse.');
    formError('No pudimos procesar la reserva. Recarga la página e inténtalo de nuevo.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reservar charla';
  }
}

function showDone(d) {
  const b = d.booking;
  $('booking-flow').hidden = true;
  $('view-done').hidden = false;
  $('done-when').textContent = `${longDate(b.slotStart)} · ${time12(b.slotStart)} (hora Colombia) · 40 min por voz en 🔊 ML-TEMP`;
  $('done-user').textContent = `Usuario de Discord: ${b.discordUsername}. ¿Está bien escrito? Con ese usuario te damos el acceso. Si no, cancela y reserva otra vez.`;
  // El token va en el fragmento (#): no viaja al servidor ni sale en ningun Referer.
  $('manage-link').value = new URL(`reserva.html#${d.manageToken}`, location.href).href;
  // El foco pasa al titulo de la confirmacion (teclado y lectores de pantalla).
  $('done-title').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function copyLink() {
  const input = $('manage-link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  $('copy').textContent = '¡Copiado!';
  setTimeout(() => ($('copy').textContent = 'Copiar enlace'), 1800);
}

// ---- Arranque
function bind() {
  $('form').addEventListener('submit', submitBooking);
  $('copy').addEventListener('click', copyLink);
  $('retry').addEventListener('click', init);
  $('message').addEventListener('input', () => {
    $('message-count').textContent = `${$('message').value.length} / 300`;
  });
}

async function init() {
  if (!isConfigured()) {
    $('days').replaceChildren(el('p', { class: 'notice' }, 'La agenda aún no está configurada. Vuelve en un momento.'));
    return;
  }
  $('load-error').hidden = true;
  $('days').replaceChildren(el('p', { class: 'loading' }, 'Cargando horarios…'));
  try {
    await loadSlots();
  } catch {
    $('days').replaceChildren();
    $('load-error').hidden = false;
    return;
  }
  renderDays();
  const first = state.data.days.find((d) => freeCount(d) > 0);
  if (first) selectDay(first.date);
}

bind();
init();
