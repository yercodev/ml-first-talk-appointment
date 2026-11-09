// Validacion del formulario en el navegador. ESPEJO de las reglas de `ml_book` (SQL): el servidor sigue siendo
// la autoridad, esto solo evita enviar lo que se sabe que va a rechazar. Los tests comparan ambos lados.
// Los textos son los mismos que devuelve el servidor.
export const LIMITS = { discord: 32, name: 32, riotMax: 22, message: 300 };

const DISCORD_OLD = 'Ese es el formato antiguo de Discord. Abre tu perfil y copia tu usuario actual.';
const DISCORD_BAD = 'Escribe tu usuario de Discord: de 2 a 32 caracteres, solo letras, números, punto y guion bajo, sin espacios.';
const NAME_BAD = 'Escribe tu nombre o nick (de 2 a 32 caracteres).';
const RIOT_BAD = 'El Riot ID va así: nombre#tag.';
const ROLE_BAD = 'Elige uno de los roles de la lista.';
const MESSAGE_BAD = 'El mensaje puede tener hasta 300 caracteres.';
const PRIVACY_BAD = 'Para reservar tienes que aceptar el aviso de privacidad.';

const ROLES = ['duelista', 'iniciador', 'controlador', 'centinela', 'flex'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Devuelve { campo: mensaje } con los errores; vacio si todo esta bien. */
export function validateForm(v) {
  const errors = {};

  const user = String(v.discordUsername ?? '').trim().toLowerCase().replace(/^@/, '');
  if (/#[0-9]{1,4}$/.test(user)) errors.discordUsername = DISCORD_OLD;
  else if (!/^[a-z0-9_.]{2,32}$/.test(user) || user.includes('..')) errors.discordUsername = DISCORD_BAD;

  const name = String(v.displayName ?? '').trim();
  if (name.length < 2 || name.length > LIMITS.name || CONTROL.test(name)) errors.displayName = NAME_BAD;

  const riot = String(v.riotId ?? '').trim();
  if (riot && (!/^[^#\s][^#]{2,15}#[A-Za-z0-9]{3,5}$/.test(riot) || CONTROL.test(riot))) errors.riotId = RIOT_BAD;

  const role = String(v.mainRole ?? '').trim().toLowerCase();
  if (role && !ROLES.includes(role)) errors.mainRole = ROLE_BAD;

  const message = String(v.message ?? '').trim();
  if (message.length > LIMITS.message) errors.message = MESSAGE_BAD;

  if (v.privacyAccepted !== true) errors.privacyAccepted = PRIVACY_BAD;
  return errors;
}
