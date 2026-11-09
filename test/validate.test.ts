import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  normalizeDiscordUsername,
  validateDiscordUsername,
  validateDisplayName,
  validateNote,
  validateRiotId,
  validateRole,
} from '../src/validate';

describe('usuario de Discord', () => {
  it('normaliza: trim, minusculas y sin @', () => {
    expect(normalizeDiscordUsername('  @MrLordPPal ')).toBe('mrlordppal');
    expect(validateDiscordUsername('@Juan_Perez.01')).toBe('juan_perez.01');
  });

  it.each(['Juan Perez', 'juan#1234', 'a', 'x'.repeat(33), 'a..b', 'ñandú', '', '   ', 'juan!'])('rechaza %j', (v) => {
    expect(() => validateDiscordUsername(v)).toThrow(ValidationError);
  });

  it('el error explica donde esta el nombre de usuario', () => {
    expect(() => validateDiscordUsername('Juan Perez')).toThrow(/Ajustes → Mi cuenta/);
    expect(() => validateDiscordUsername('juan#1234')).toThrow(/Ajustes → Mi cuenta/);
  });

  it('rechaza no-strings', () => {
    expect(() => validateDiscordUsername(undefined)).toThrow(ValidationError);
    expect(() => validateDiscordUsername(42)).toThrow(ValidationError);
  });
});

describe('nombre', () => {
  it('acepta 2-40 caracteres y colapsa espacios', () => {
    expect(validateDisplayName('  Juan   Pérez ')).toBe('Juan Pérez');
  });
  it.each(['a', 'x'.repeat(41), 'Ju\u0000an', 'Ju\nan', 7])('rechaza %j', (v) => {
    expect(() => validateDisplayName(v)).toThrow(ValidationError);
  });
});

describe('Riot ID', () => {
  it('es opcional', () => {
    expect(validateRiotId(undefined)).toBeNull();
    expect(validateRiotId('  ')).toBeNull();
  });
  it('acepta nombre#TAG', () => {
    expect(validateRiotId('Yerco#LAS')).toBe('Yerco#LAS');
    expect(validateRiotId('Mr Lord#1234')).toBe('Mr Lord#1234');
  });
  it.each(['sin tag', '#TAG', 'a#', 'a#ab', 'a#toolong1', 'a#b#cde'])('rechaza %j', (v) => {
    expect(() => validateRiotId(v)).toThrow(ValidationError);
  });
});

describe('rol y nota', () => {
  it('rol opcional y de la lista', () => {
    expect(validateRole(undefined)).toBeNull();
    expect(validateRole('Duelista')).toBe('duelista');
    expect(() => validateRole('support')).toThrow(ValidationError);
  });
  it('nota opcional hasta 300', () => {
    expect(validateNote('')).toBeNull();
    expect(validateNote('x'.repeat(300))).toHaveLength(300);
    expect(() => validateNote('x'.repeat(301))).toThrow(ValidationError);
  });
});
