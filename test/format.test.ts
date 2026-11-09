import { describe, expect, it } from 'vitest';
import { CLOSED_LINE2_BEFORE, CLOSED_LINE2_LINK, CLOSED_TITLE, chipUntilText, closedLine1, colombiaSuffix, dateMid, dayLabel, localDate, longDate, noSlotsBefore, range, time12, visitorLocal, weekdayDay } from '../site/lib/format.js';

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

describe('textos del cierre de la convocatoria (ML-002): la fecha sale de bookingUntil y va en minuscula a mitad de frase', () => {
  const UNTIL = '2026-11-15'; // domingo

  it('longDate (inicio de linea) lleva mayuscula; dateMid (mitad de frase) no', () => {
    expect(longDate(Date.parse('2026-11-15T12:00:00Z'), 0)).toBe('Domingo 15 de noviembre');
    expect(dateMid(UNTIL)).toBe('domingo 15 de noviembre');
    expect(dateMid('2026-11-22')).toBe('domingo 22 de noviembre');
    expect(dateMid('2026-11-16')).toBe('lunes 16 de noviembre');
  });

  it('chip, titular y lineas, literales de marketing', () => {
    expect(chipUntilText(UNTIL)).toBe('Charlas hasta el domingo 15 de noviembre');
    expect(chipUntilText(UNTIL).endsWith('.')).toBe(false);
    expect(CLOSED_TITLE).toBe('La convocatoria cerró');
    expect(closedLine1(UNTIL)).toBe('Las charlas del proceso fueron hasta el domingo 15 de noviembre.');
    expect(CLOSED_LINE2_BEFORE + CLOSED_LINE2_LINK + '.').toBe('Si te postulaste y no alcanzaste a reservar, escríbele a Yerco en YercoVerse.');
    expect(noSlotsBefore(UNTIL) + CLOSED_LINE2_BEFORE + CLOSED_LINE2_LINK + '.').toBe(
      'Ya no quedan horarios libres: el último día de charlas es el domingo 15 de noviembre. Si te postulaste y no alcanzaste a reservar, escríbele a Yerco en YercoVerse.',
    );
  });

  it('cambiar la fecha de cierre cambia todos los textos (no hay fecha escrita a mano)', () => {
    for (const f of [chipUntilText, closedLine1, noSlotsBefore]) {
      expect(f('2026-11-22')).toContain('domingo 22 de noviembre');
      expect(f('2026-11-22')).not.toContain('15 de noviembre');
      expect(f(UNTIL)).not.toMatch(/Domingo/); // sin mayuscula en mitad de frase
    }
  });
});

