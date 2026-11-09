export const ROLES = ['duelista', 'iniciador', 'controlador', 'centinela', 'flex'] as const;
export type MainRole = (typeof ROLES)[number];

export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
  ) {
    super(message);
  }
}

const DISCORD_HELP =
  'Escribe tu nombre de usuario de Discord, no tu nombre visible. Lo encuentras en Ajustes → Mi cuenta (por ejemplo: juan_perez).';

/** Normaliza: trim, minusculas y sin la @ inicial. */
export function normalizeDiscordUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '');
}

const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;

export function validateDiscordUsername(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ValidationError(`Falta tu usuario de Discord. ${DISCORD_HELP}`, 'discord');
  }
  const user = normalizeDiscordUsername(raw);
  if (/#\d{1,4}$/.test(user)) {
    throw new ValidationError(
      `Ese formato con # ya no se usa en Discord. ${DISCORD_HELP}`,
      'discord',
    );
  }
  if (/\s/.test(user)) {
    throw new ValidationError(
      `El usuario de Discord no lleva espacios: parece que pusiste tu nombre visible. ${DISCORD_HELP}`,
      'discord',
    );
  }
  if (!USERNAME_RE.test(user) || user.includes('..')) {
    throw new ValidationError(
      `Ese usuario no es válido (solo letras minúsculas, números, guion bajo y punto; de 2 a 32 caracteres, sin dos puntos seguidos). ${DISCORD_HELP}`,
      'discord',
    );
  }
  return user;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function validateDisplayName(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError('Tu nombre tiene caracteres no permitidos.', 'name');
  }
  const name = trimmed.replace(/ {2,}/g, ' ');
  if (name.length < 2 || name.length > 40) {
    throw new ValidationError('Tu nombre debe tener entre 2 y 40 caracteres.', 'name');
  }
  return name;
}

const RIOT_RE = /^[^#\s][^#]{0,15}#[A-Za-z0-9]{3,5}$/;

export function validateRiotId(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new ValidationError('El Riot ID no es válido.', 'riotId');
  const v = raw.trim();
  if (!v) return null;
  if (!RIOT_RE.test(v) || CONTROL_RE.test(v)) {
    throw new ValidationError('Tu Riot ID debe tener el formato nombre#TAG (por ejemplo: Yerco#LAS).', 'riotId');
  }
  return v;
}

export function validateRole(raw: unknown): MainRole | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new ValidationError('El rol no es válido.', 'role');
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (!(ROLES as readonly string[]).includes(v)) {
    throw new ValidationError('Elige un rol de la lista: duelista, iniciador, controlador, centinela o flex.', 'role');
  }
  return v as MainRole;
}

export function validateNote(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new ValidationError('La nota no es válida.', 'note');
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 300) throw new ValidationError('La nota puede tener hasta 300 caracteres.', 'note');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) {
    throw new ValidationError('La nota tiene caracteres no permitidos.', 'note');
  }
  return v;
}
