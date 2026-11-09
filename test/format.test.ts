import { describe, expect, it } from 'vitest';
import { colombiaSuffix, dayLabel, localDate, longDate, range, time12, visitorLocal, weekdayDay } from '../site/lib/format.js';

const OFF = -300; // hora Colombia
const NB = ' '; // espacio de no separacion entre la hora y AM/PM
const utc = (s: string) => Date.parse(s);

describe('formato del front (zona de la agenda, no la del navegador)', () => {
  it('formato «4:30 PM» con espacio de no separacion', () => {
    expect(time12(utc('2026-11-08T17:00:00Z'), OFF)).toBe(`12:00${NB}PM`);
    expect(time12(utc('2026-11-08T05:05:00Z'), OFF)).toBe(`12:05${NB}AM`);
    expect(time12(utc('2026-11-08T21:30:00Z'), OFF)).toBe(`4:30${NB}PM`);
  });

  it('rango de un cupo, incluido el ultimo (que cruza la medianoche UTC)', () => {
    expect(range(utc('2026-11-08T21:30:00Z'), 40, OFF)).toBe(`4:30${NB}PM – 5:10${NB}PM`);
    expect(range(utc('2026-11-09T02:50:00Z'), 40, OFF)).toBe(`9:50${NB}PM – 10:30${NB}PM`);
  });

  it('fecha larga completa y con mayuscula usando el dia local', () => {
    expect(longDate(utc('2026-11-11T02:50:00Z'), OFF)).toBe('Martes 10 de noviembre'); // 21:50 COT del martes 10
    expect(longDate(utc('2026-11-14T22:10:00Z'), OFF)).toBe('Sábado 14 de noviembre');
    expect(longDate(utc('2026-12-12T22:10:00Z'), OFF)).toBe('Sábado 12 de diciembre');
  });

  it('Hoy / Mañana / Lun 10', () => {
    const now = utc('2026-11-09T02:00:00Z'); // 21:00 COT del domingo 8
    expect(localDate(now, OFF)).toBe('2026-11-08');
    expect(dayLabel('2026-11-08', now, OFF)).toBe('Hoy');
    expect(dayLabel('2026-11-09', now, OFF)).toBe('Mañana');
    expect(dayLabel('2026-11-10', now, OFF)).toBe('Mar 10');
  });

  it('hora del visitante: misma zona -> nada; otra zona -> hora; si cambia el dia, tambien el dia', () => {
    const start = utc('2026-11-12T22:10:00Z'); // 5:10 PM en Colombia
    expect(visitorLocal(start, OFF, OFF)).toBeNull();
    expect(colombiaSuffix(start, OFF, OFF)).toBe('(hora Colombia)');
    expect(visitorLocal(start, OFF, -360)).toEqual({ time: `4:10${NB}PM`, day: null }); // Mexico
    expect(colombiaSuffix(start, OFF, -360)).toBe(`(hora Colombia; en tu hora, 4:10${NB}PM)`);
    const late = utc('2026-11-13T02:50:00Z'); // 9:50 PM en Colombia
    expect(visitorLocal(late, OFF, 60)).toEqual({ time: `3:50${NB}AM`, day: 'vie 13' }); // Madrid
    expect(colombiaSuffix(late, OFF, 60)).toBe(`(hora Colombia; en tu hora, vie 13, 3:50${NB}AM)`);
    expect(weekdayDay(late, 60)).toBe('vie 13');
  });
});
