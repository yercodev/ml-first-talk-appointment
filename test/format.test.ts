import { describe, expect, it } from 'vitest';
import { escapeMarkdown, formatDateEs, formatTime12 } from '../src/format';

describe('fechas', () => {
  it('formato humano en español', () => {
    // dom 8 nov 2026, 17:10 COT = 22:10 UTC
    const ms = Date.parse('2026-11-08T22:10:00Z');
    expect(formatDateEs(ms, -300, 'hora Colombia')).toBe('dom 8 nov · 5:10 PM (hora Colombia)');
  });
  it('sabado correcto', () => {
    const ms = Date.parse('2026-11-14T22:10:00Z');
    expect(formatDateEs(ms, -300, 'hora Colombia')).toBe('sáb 14 nov · 5:10 PM (hora Colombia)');
  });
  it('12 AM / 12 PM', () => {
    expect(formatTime12(Date.parse('2026-11-08T17:00:00Z'), -300)).toBe('12:00 PM');
    expect(formatTime12(Date.parse('2026-11-08T05:05:00Z'), -300)).toBe('12:05 AM');
    expect(formatTime12(Date.parse('2026-11-08T21:30:00Z'), -300)).toBe('4:30 PM');
  });
  it('usa el dia local, no el UTC', () => {
    // 21:50 COT del 8 es el 9 en UTC
    expect(formatDateEs(Date.parse('2026-11-09T02:50:00Z'), -300, 'x')).toBe('dom 8 nov · 9:50 PM (x)');
  });
});

describe('escapeMarkdown', () => {
  it('escapa el markdown y las menciones', () => {
    expect(escapeMarkdown('**hola** _x_ ~~y~~ `z`')).toBe('\\*\\*hola\\*\\* \\_x\\_ \\~\\~y\\~\\~ \\`z\\`');
    expect(escapeMarkdown('@everyone <@123> <#456>')).toBe('\\@everyone \\<\\@123\\> \\<\\#456\\>');
    expect(escapeMarkdown('[a](http://x)')).toBe('\\[a\\]\\(http\\://x\\)');
    expect(escapeMarkdown('> cita\n# titulo')).toBe('\\> cita\n\\# titulo');
  });
  it('deja el texto normal intacto', () => {
    expect(escapeMarkdown('Hola, soy Juan 123')).toBe('Hola, soy Juan 123');
  });
});
