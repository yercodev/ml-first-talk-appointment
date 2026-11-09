import { describe, expect, it } from 'vitest';
import { bookableDays, formatHHMM, generateDays, isBookableSlot, localDateStr, localMidnightUtc } from '../src/slots';

const cfg = {
  tzOffsetMin: -300,
  firstSlotMinutes: 16 * 60 + 30,
  slotMinutes: 40,
  slotsPerDay: 9,
  windowDays: 14,
  minLeadMinutes: 60,
};
const utc = (s: string) => Date.parse(s);

describe('zona horaria', () => {
  it('16:30 COT son las 21:30 UTC', () => {
    const days = generateDays(utc('2026-11-08T12:00:00Z'), cfg);
    expect(new Date(days[0]!.slots[0]!.start).toISOString()).toBe('2026-11-08T21:30:00.000Z');
    expect(days[0]!.slots[0]!.time).toBe('16:30');
  });

  it('el ultimo cupo empieza a las 21:50 y acaba a las 22:30', () => {
    const last = generateDays(utc('2026-11-08T12:00:00Z'), cfg)[0]!.slots.at(-1)!;
    expect(last.time).toBe('21:50');
    expect(formatHHMM(last.end, cfg.tzOffsetMin)).toBe('22:30');
  });

  it('el ultimo cupo cruza la medianoche UTC pero sigue en el mismo dia local', () => {
    const day = generateDays(utc('2026-11-08T12:00:00Z'), cfg)[0]!;
    // 21:50 COT = 02:50 UTC del dia siguiente
    expect(new Date(day.slots.at(-1)!.start).toISOString()).toBe('2026-11-09T02:50:00.000Z');
    expect(day.date).toBe('2026-11-08');
  });

  it('a las 02:00 UTC todavia es el dia anterior en Colombia', () => {
    const now = utc('2026-11-09T02:00:00Z'); // 21:00 COT del 8
    expect(localDateStr(now, cfg.tzOffsetMin)).toBe('2026-11-08');
    expect(new Date(localMidnightUtc(now, cfg.tzOffsetMin)).toISOString()).toBe('2026-11-08T05:00:00.000Z');
    expect(generateDays(now, cfg)[0]!.date).toBe('2026-11-08');
  });

  it('a las 05:00 UTC empieza el dia nuevo en Colombia', () => {
    const now = utc('2026-11-09T05:00:00Z');
    expect(generateDays(now, cfg)[0]!.date).toBe('2026-11-09');
  });

  it('genera 14 dias de 9 cupos de 40 minutos', () => {
    const days = generateDays(utc('2026-11-08T12:00:00Z'), cfg);
    expect(days).toHaveLength(14);
    for (const d of days) expect(d.slots).toHaveLength(9);
    const s = days[0]!.slots;
    expect(s[1]!.start - s[0]!.start).toBe(40 * 60_000);
    expect(s.map((x) => x.time)).toEqual(['16:30', '17:10', '17:50', '18:30', '19:10', '19:50', '20:30', '21:10', '21:50']);
  });
});

describe('antelacion y validez del cupo', () => {
  const now = utc('2026-11-08T22:00:00Z'); // 17:00 COT
  it('omite los cupos pasados o con menos de 60 min', () => {
    const today = bookableDays(now, cfg)[0]!;
    // 17:00 + 60 = 18:00 COT; el primero valido es 18:30
    expect(today.slots[0]!.time).toBe('18:30');
  });

  it('un cupo exactamente a 60 min es reservable, a 59 no', () => {
    const slot = utc('2026-11-08T23:30:00Z'); // 18:30 COT
    expect(isBookableSlot(slot, slot - 60 * 60_000, cfg)).toBe(true);
    expect(isBookableSlot(slot, slot - 59 * 60_000, cfg)).toBe(false);
  });

  it('rechaza horas que no son un cupo generado', () => {
    expect(isBookableSlot(utc('2026-11-09T21:31:00Z'), now, cfg)).toBe(false);
    expect(isBookableSlot(NaN, now, cfg)).toBe(false);
  });

  it('rechaza dias fuera de la ventana', () => {
    expect(isBookableSlot(utc('2026-11-23T21:30:00Z'), now, cfg)).toBe(false); // dia 16
    expect(isBookableSlot(utc('2026-11-21T21:30:00Z'), now, cfg)).toBe(true); // dia 14
  });

  it('omite los dias sin cupos', () => {
    const late = utc('2026-11-09T02:00:00Z'); // 21:00 COT: ya no cabe nadie hoy (21:50 < 22:00)
    expect(bookableDays(late, cfg)[0]!.date).toBe('2026-11-09');
  });
});
