// Acceso a Postgres para los tests de SQL.
//  - Con TEST_DATABASE_URL (CI: service container postgres:16) usa Postgres real y permite
//    conexiones concurrentes (la prueba de carrera).
//  - Sin ella usa PGlite (Postgres en WASM, una sola conexion): cubre todo lo funcional.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// 0001 + 0002 (en orden). Se aplican siempre juntas, como las pega Yerco.
export const MIGRATION = ['0001_mountain_lords_agenda.sql', '0002_pgrst_error_format.sql', '0003_safeupdate_y_cierre.sql']
  .map((f) => readFileSync(join(here, '../../supabase/migrations', f), 'utf8'))
  .join(';\n');

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema public to anon, authenticated, service_role;
`;

const RESET = `
drop schema if exists mountain_lords cascade;
drop function if exists public.ml_slots();
drop function if exists public.ml_book(timestamptz, text, text, text, text, text, boolean, text);
drop function if exists public.ml_booking_lookup(text);
drop function if exists public.ml_booking_cancel(text);
drop function if exists public.ml_admin_agenda(text);
drop function if exists public.ml_admin_cancel(text, uuid);
drop function if exists public.ml_admin_block(text, timestamptz, date);
drop function if exists public.ml_admin_unblock(text, timestamptz, date);
drop function if exists public.ml_integration_pending(boolean);
drop function if exists public.ml_integration_ack(jsonb);
drop function if exists public.ml_admin_purge_test(text);
`;

export interface Harness {
  db: Db;
  /** Solo con Postgres real: abre otra conexion independiente. */
  newClient?: () => Promise<Db>;
  kind: 'pg' | 'pglite';
}

export async function setup(): Promise<Harness> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { Client } = await import('pg');
    const open = async (): Promise<Db> => {
      const c = new Client({ connectionString: url });
      await c.connect();
      return {
        query: async (sql, params) => (await c.query(sql, params as any[])).rows,
        close: () => c.end(),
      };
    };
    const db = await open();
    await db.query(RESET);
    await db.query(BOOTSTRAP);
    await db.query(MIGRATION);
    return { db, newClient: open, kind: 'pg' };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = new PGlite({ extensions: { pgcrypto } });
  const db: Db = {
    query: async (sql, params) => {
      if (params && params.length) return (await pg.query(sql, params as any[])).rows as any[];
      // Sin parametros se admiten varias sentencias (scripts).
      const res = await pg.exec(sql);
      return (res[res.length - 1]?.rows ?? []) as any[];
    },
    close: () => pg.close(),
  };
  await db.query(RESET);
  await db.query(BOOTSTRAP);
  await db.query(MIGRATION);
  return { db, kind: 'pglite' };
}
