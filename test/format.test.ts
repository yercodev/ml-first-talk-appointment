import { describe, expect, it } from 'vitest';
import { dayLabel, localDate, longDate, range, time12 } from '../site/lib/format.js';

const OFF = -300; // hora Colombia
const utc = (s: string) => Date.parse(s);

describe('formato del front (zona de la agenda, no la del navegador)', () => {
  it('12 a. m. / 12 p. m. / p. m.', () => {
    expect(time12(utc('2026-11-08T17:00:00Z'), OFF)).toBe('12:00 p. m.');
    expect(time12(utc('2026-11-08T05:05:00Z'), OFF)).toBe('12:05 a. m.');
    expect(time12(utc('2026-11-08T21:30:00Z'), OFF)).toBe('4:30 p. m.');
  });

  it('rango de un cupo, incluido el ultimo (que cruza la medianoche UTC)', () => {
    expect(range(utc('2026-11-08T21:30:00Z'), 40, OFF)).toBe('4:30 p. m. – 5:10 p. m.');
    expect(range(utc('2026-11-09T02:50:00Z'), 40, OFF)).toBe('9:50 p. m. – 10:30 p. m.');
  });

  it('fecha larga en español usando el dia local', () => {
    expect(longDate(utc('2026-11-11T02:50:00Z'), OFF)).toBe('martes 10 de nov'); // 21:50 COT del martes 10
    expect(longDate(utc('2026-11-14T22:10:00Z'), OFF)).toBe('sábado 14 de nov');
  });

  it('Hoy / Mañana / Lun 10', () => {
    const now = utc('2026-11-09T02:00:00Z'); // 21:00 COT del domingo 8
    expect(localDate(now, OFF)).toBe('2026-11-08');
    expect(dayLabel('2026-11-08', now, OFF)).toBe('Hoy');
    expect(dayLabel('2026-11-09', now, OFF)).toBe('Mañana');
    expect(dayLabel('2026-11-10', now, OFF)).toBe('Mar 10');
  });
});
