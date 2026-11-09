// Genera el SQL que guarda el hash bcrypt de la clave de admin (la clave nunca va al repo).
//   node scripts/hash-admin-key.mjs <archivo.env con ADMIN_TOKEN=...>   > staging-config.sql
//   o: ML_ADMIN_KEY=... node scripts/hash-admin-key.mjs
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

let key = process.env.ML_ADMIN_KEY;
if (!key && process.argv[2]) key = readFileSync(process.argv[2], 'utf8').match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim();
if (!key) {
  console.error('Falta la clave: ML_ADMIN_KEY o un archivo .env con ADMIN_TOKEN=');
  process.exit(2);
}
const pg = new PGlite({ extensions: { pgcrypto } });
await pg.exec('create schema extensions; create extension pgcrypto schema extensions;');
const { rows } = await pg.query(`select extensions.crypt($1, extensions.gen_salt('bf', 10)) as h`, [key]);
const ok = await pg.query(`select extensions.crypt($1, $2) = $2 as ok`, [key, rows[0].h]);
if (!ok.rows[0].ok) throw new Error('el hash no verifica');
console.log(`-- Mountain Lords: clave de administrador. Pegar en el SQL Editor DESPUES de la migracion 0001.
-- Guarda solo el hash bcrypt (la clave real no esta aqui). Idempotente.
update mountain_lords.settings set admin_key_hash = '${rows[0].h}';`);
