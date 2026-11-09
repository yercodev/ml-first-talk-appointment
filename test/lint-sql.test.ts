// Lint de las migraciones: Supabase carga `pg_safeupdate` en las peticiones de PostgREST y esa extension rechaza
// UPDATE/DELETE sin WHERE (21000 «UPDATE requires a WHERE clause»). El Postgres/PostgREST del CI no la carga, asi que
// este lint es el que lo impide: ningun UPDATE ni DELETE sobre `mountain_lords.*` puede ir sin WHERE.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../supabase/migrations');

/** Quita comentarios de linea y de bloque (sin tocar el resto). */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Devuelve las sentencias UPDATE/DELETE sobre mountain_lords.* que no llevan WHERE. */
export function unsafeStatements(sql: string): string[] {
  const clean = stripComments(sql);
  const out: string[] = [];
  const re = /\b(update\s+mountain_lords\.\w+|delete\s+from\s+mountain_lords\.\w+)([^;]*);/gi;
  for (const m of clean.matchAll(re)) {
    if (!/\bwhere\b/i.test(m[2] ?? '')) out.push(`${m[1]}${m[2]}`.replace(/\s+/g, ' ').trim());
  }
  return out;
}

describe('lint de las migraciones (pg_safeupdate)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

  it('hay migraciones que revisar', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)('%s: ningun UPDATE/DELETE sobre mountain_lords.* sin WHERE', (f) => {
    expect(unsafeStatements(readFileSync(join(DIR, f), 'utf8'))).toEqual([]);
  });

  it('el lint detecta el caso que fallo en staging (y no da falsos positivos)', () => {
    expect(unsafeStatements('update mountain_lords.integration_run set last_run_at = v_now;')).toHaveLength(1);
    expect(unsafeStatements('delete from mountain_lords.booking;')).toHaveLength(1);
    expect(unsafeStatements('update mountain_lords.integration_run set last_run_at = v_now where id;')).toEqual([]);
    expect(unsafeStatements('delete from mountain_lords.booking where x < 1;')).toEqual([]);
    expect(unsafeStatements('-- update mountain_lords.a set b = 1;\nselect 1;')).toEqual([]);
    expect(unsafeStatements("insert into mountain_lords.t as t (k) values (1) on conflict (k) do update set a = 1 where t.x is null;")).toEqual([]);
  });
});
