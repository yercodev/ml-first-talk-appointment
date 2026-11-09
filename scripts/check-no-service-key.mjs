// Falla (exit 1) si algun archivo del sitio lleva una clave service_role o una sb_secret_.
// Uso: node scripts/check-no-service-key.mjs <carpeta>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const dir = process.argv[2] || 'site';
const TEXT = new Set(['.html', '.js', '.css', '.json', '.txt', '.map']);
let bad = 0;
let jwts = 0;

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.has(extname(p))) scan(p, readFileSync(p, 'utf8'));
  }
}

function scan(file, text) {
  if (text.includes('sb_secret_')) {
    console.error(`FALLO ${file}: contiene una clave sb_secret_`);
    bad++;
  }
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
    jwts++;
    try {
      const role = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')).role;
      if (role === 'service_role') {
        console.error(`FALLO ${file}: lleva un JWT con role=service_role`);
        bad++;
      }
    } catch {
      /* no era un JWT */
    }
  }
}

walk(dir);
console.log(`Revisado ${dir}: ${jwts} JWT, ${bad} problemas.`);
process.exit(bad ? 1 : 0);
