import { rpc, isConfigured, refuseFraming } from './lib/api.js';
import * as fmt from './lib/format.js';

refuseFraming();

const $ = (id) => document.getElementById(id);
// El token vive en el fragmento (#): nunca viaja al servidor ni sale en un Referer.
const token = decodeURIComponent(location.hash.slice(1));
const OFFSET = -300;

function setState(title, text, { when = null, again = false } = {}) {
  $('r-title').textContent = title;
  $('r-text').textContent = text;
  $('r-when').hidden = !when;
  if (when) $('r-when').textContent = when;
  $('r-again').hidden = !again;
  $('r-actions').hidden = true;
  $('r-confirm').hidden = true;
}

function describe(b) {
  const start = Date.parse(b.slotStart);
  return `${fmt.longDate(start, OFFSET)} · ${fmt.time12(start, OFFSET)} (hora Colombia) · 40 min por voz en 🔊 ML-TEMP`;
}

function render(b) {
  const when = describe(b);
  if (b.status === 'cancelled') {
    return b.cancelledBy === 'admin'
      ? setState('Charla cancelada', 'Yerco canceló esta charla. Puedes reservar otro horario.', { when, again: true })
      : setState('Charla cancelada', 'Esta charla ya está cancelada.', { when, again: true });
  }
  if (b.started) {
    return setState('Tu reserva', 'Esta charla ya empezó o ya pasó; no se puede cancelar.', { when });
  }
  setState('Tu reserva', `Usuario de Discord: ${b.discordUsername}. Abrir este enlace no cancela nada.`, { when });
  $('r-actions').hidden = false;
}

async function load() {
  if (!token || !isConfigured()) {
    return setState('Tu reserva', 'Este enlace no es válido o la reserva ya se borró.', { again: true });
  }
  const r = await rpc('ml_booking_lookup', { p_token: token });
  if (r.status === 0) return setState('Tu reserva', 'No pudimos cargar tu reserva. Revisa tu conexión y recarga la página.');
  if (!r.ok) return setState('Tu reserva', 'Este enlace no es válido o la reserva ya se borró.', { again: true });
  render(r.data.booking);
}

$('r-cancel').addEventListener('click', () => {
  $('r-actions').hidden = true;
  $('r-confirm').hidden = false;
});
$('r-no').addEventListener('click', () => {
  $('r-confirm').hidden = true;
  $('r-actions').hidden = false;
});
$('r-yes').addEventListener('click', async () => {
  $('r-yes').disabled = true;
  const r = await rpc('ml_booking_cancel', { p_token: token });
  $('r-yes').disabled = false;
  if (r.status === 0) return ($('r-text').textContent = 'No hay conexión con el servidor. Inténtalo de nuevo.');
  if (r.data.code === 'already_started') return setState('Tu reserva', 'Esta charla ya empezó o ya pasó; no se puede cancelar.');
  if (!r.ok) return setState('Tu reserva', 'Este enlace no es válido o la reserva ya se borró.', { again: true });
  setState('Charla cancelada', r.data.alreadyCancelled ? 'Esta charla ya está cancelada.' : 'Charla cancelada. Puedes reservar otra cuando quieras.', { again: true });
});

load();
