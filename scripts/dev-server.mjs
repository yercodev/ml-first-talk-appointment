// Servidor local de desarrollo: sirve site/ y emula PostgREST (POST /rest/v1/rpc/<fn>) sobre PGlite
// con la migracion real. No toca Supabase ni Discord.
//   node scripts/dev-server.mjs [puerto]      (por defecto 8799)
// Variables: FAKE_NOW=2026-11-10T17:00:00Z fija el reloj; ADMIN_KEY (por defecto "dev-admin").
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const site = join(root, 'site');
const port = Number(process.argv[2] || 8799);
const origin = `http://localhost:${port}`;
const adminKey = process.env.ADMIN_KEY || 'dev-admin';

const pg = new PGlite({ extensions: { pgcrypto } });
await pg.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  grant usage on schema public to anon, authenticated, service_role;
`);
for (const f of readdirSync(join(root, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  await pg.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
}
await pg.query(`update mountain_lords.settings set admin_key_hash = extensions.crypt($1, extensions.gen_salt('bf', 6))`, [adminKey]);
if (process.env.FAKE_NOW) await pg.query(`update mountain_lords.settings set allow_fake_now = true, fake_now = $1`, [process.env.FAKE_NOW]);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

async function rpc(fn, body, ip) {
  if (!/^ml_[a-z_]+$/.test(fn)) return [404, { code: 'PGRST202', message: 'function not found' }];
  const keys = Object.keys(body || {});
  const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  await pg.query(`select set_config('request.headers', $1, false)`, [JSON.stringify(ip ? { 'cf-connecting-ip': ip } : {})]);
  await pg.query(`select set_config('response.status', '', false)`);
  try {
    const res = await pg.query(`select public.${fn}(${args}) as r`, keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k])));
    const st = (await pg.query(`select current_setting('response.status', true) as s`)).rows[0].s;
    return [st ? Number(st) : 200, res.rows[0].r];
  } catch (e) {
    if (e.code === 'PGRST') return [JSON.parse(e.detail).status, JSON.parse(e.message)];
    return [400, { code: e.code || 'error', message: e.message }];
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const [status, data] = await rpc(url.pathname.split('/').pop(), body, req.headers['cf-connecting-ip'] || req.headers['x-test-ip']);
    return res.writeHead(status, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify(data));
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!path) path = 'index.html';
  let file = join(site, path);
  if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end('no encontrado');
    return;
  }
  let data = readFileSync(file);
  const type = TYPES[extname(file)] || 'application/octet-stream';
  if (extname(file) === '.html') data = Buffer.from(data.toString('utf8').replaceAll('https://dojgxfotawtxitgcppyn.supabase.co', origin));
  if (path === 'config.js') data = Buffer.from(`window.ML_CONFIG = { supabaseUrl: '${origin}', anonKey: 'dev-anon-key' };\n`);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(data);
}).listen(port, () => console.log(`Agenda local en ${origin} (admin: ${adminKey})`));
