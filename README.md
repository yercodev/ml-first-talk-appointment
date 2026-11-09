# Agenda de primera charla · Mountain Lords

Los aspirantes a Mountain Lords (equipo de esports de VALORANT) eligen un cupo de 40 minutos, dejan su usuario de Discord y, al entrar al servidor YercoVerse, un bot les da el rol **ML-temp**. Yerco recibe avisos por DM.

Es un producto aparte de yercoyt.com y de rhaestore: no comparte código, Workers ni base de datos con ellos. Especificación: `ai-agents/product-manager/HU/mountain-lords/HU-001-agenda-primera-charla.md`.

## Arquitectura

```
GitHub Pages (site/)  ──fetch + clave anon──▶  funciones public.ml_*  ──▶  esquema mountain_lords
                                                (Supabase de STAGING)        (no expuesto por PostgREST)
                                                        ▲
n8n «ML-Agenda-Discord» (cada minuto, service_role) ────┘  pending → Discord → ack
```

- **Front** (`site/`): HTML/CSS/JS sin framework ni dependencias. Páginas: `index.html` (reservar), `reserva.html` (ver y cancelar con el enlace), `admin.html` (clave de administrador) y `privacidad.html`. CSP y política de referrer en `<meta>` (GitHub Pages no admite cabeceras). Fuentes Teko e Inter propias (`site/fonts/`, licencias OFL junto a ellas).
- **Base de datos** (`supabase/migrations/0001_mountain_lords_agenda.sql`): toda la lógica vive en SQL (grilla, reglas, textos de Discord, limpieza). Diez funciones `public.ml_*` `SECURITY DEFINER`:
  - públicas (anon): `ml_slots`, `ml_book`, `ml_booking_lookup`, `ml_booking_cancel`;
  - administración (anon + clave, comparada con un hash bcrypt): `ml_admin_agenda`, `ml_admin_cancel`, `ml_admin_block`, `ml_admin_unblock`;
  - integración (**solo `service_role`**): `ml_integration_pending`, `ml_integration_ack`.
- **n8n** (`n8n/ML-Agenda-Discord.json`, sin credenciales): solo transporta. Lista los miembros, pone el rol y envía lo que SQL ya redactó.

## Qué escribe el bot en Discord

Todo lo redacta SQL (`mountain_lords.*` en la migración) y lo prueba el CI:

| Mensaje | Destino |
|---|---|
| Nueva charla (con Riot ID, rol y mensaje) | DM a Yerco |
| Entró a YercoVerse y ya tiene ML-temp | DM a Yerco |
| Bienvenida, mencionando al aspirante | #ml-temp |
| En 15 min (con la presencia comprobada) | DM a Yerco |
| Tu charla empieza en 15 minutos | #ml-temp, solo si el aspirante está en el servidor |
| Cancelada (solo si cancela el aspirante) | DM a Yerco |
| Agenda de hoy (desde las 4:00 p. m., solo si hay charlas) | DM a Yerco |

También **pone el rol ML-temp** (`PUT /guilds/{guild}/members/{user}/roles/{rol}`). No lo quita nunca. Lo que escribe el aspirante va escapado y con `allowed_mentions` restringido; su mensaje solo aparece en los DMs a Yerco.

## Cambiar el horario

Todo está en `mountain_lords.settings` (una fila). Se cambia con un `UPDATE` en el SQL Editor, sin desplegar nada:

```sql
update mountain_lords.settings set slot_minutes = 30, day_end = '21:30';   -- 10 cupos de 4:30 a 9:30 p. m.
update mountain_lords.settings set window_days = 21, min_lead_minutes = 120;
```

Campos: `utc_offset`, `day_start`, `day_end`, `slot_minutes`, `window_days`, `min_lead_minutes`, `max_bookings_per_ip_per_day`, `retention_days`, `reminder_minutes`, `daily_agenda_time`, `lease_seconds`, y los ids de Discord. Las reservas existentes no se mueven.

## Correrlo en local (sin Supabase ni Discord)

```bash
npm ci
npm run dev          # http://localhost:8799  ·  admin: clave "dev-admin"
```

`scripts/dev-server.mjs` sirve `site/` y emula PostgREST sobre PGlite con la migración real. Para fijar el reloj: `FAKE_NOW=2026-11-10T17:00:00Z npm run dev`.

```bash
npm run typecheck    # tsc
npm test             # formato del front + SQL (PGlite; con TEST_DATABASE_URL, Postgres real y carreras)
npm run check        # que el sitio no lleve claves service_role
```

Los tests de SQL cubren los escenarios de la HU. Con `TEST_DATABASE_URL=postgres://…` (en CI, un contenedor `postgres:16`) se ejecutan además las pruebas de **carrera real**: 10 conexiones al mismo cupo → exactamente 1 reserva.

## Puesta en marcha (lo hace Yerco)

1. **Base de datos de staging** (`dojgxfotawtxitgcppyn`), en el SQL Editor y en este orden:
   1. el contenido de `supabase/migrations/0001_mountain_lords_agenda.sql` (se puede ejecutar dos veces);
   2. el hash de la clave de administrador: `ai-agents/developer/ml-first-talk/staging-config.sql` (la clave real está en `pagina/.ml-first-talk.env`, fuera del repo). Para generarlo otra vez: `node scripts/hash-admin-key.mjs <archivo.env>`.
   - No añadas `mountain_lords` a «Exposed schemas» de la API.
2. **Clave anon de staging** (pública): en GitHub, *Settings → Secrets and variables → Actions → Variables*, crea `ML_ANON_KEY`. El workflow la inyecta en `config.js` al publicar. (Alternativa: sustituir `PEGAR_ANON_KEY_STAGING` en `site/config.js`.)
3. **GitHub Pages**: *Settings → Pages → Source: GitHub Actions* (lo hace un administrador del repo).
4. **Mergear la PR a `main`** publica `https://yercodev.github.io/ml-first-talk-appointment/` tras pasar los tests.
5. **n8n**: en el workflow `ML-Agenda-Discord` (creado desactivado y con `DRY_RUN = true`):
   - crea una credencial *Supabase API* con la URL de staging y la clave **legacy `service_role`** (no la `sb_secret_`, que falla a ratos con «JWT issued at future») y asígnala a los nodos *Pendiente*, *Ack (dry run)*, *Ack 1* y *Ack 2*;
   - ejecuta una vez en modo manual con `DRY_RUN = true` y revisa el plan del último nodo;
   - cuando lo apruebes, pon `DRY_RUN = false` y **publica** el workflow.
6. Prueba de humo contra staging: `ML_ANON_KEY=… ML_ADMIN_KEY=… node scripts/smoke.mjs`.

## CI/CD

`.github/workflows/deploy.yml`: `check` (typecheck, tests con `postgres:16`, comprobación de claves) → `build` (sitio con `version.json` con el SHA) → `deploy` (solo en push a `main`) con prueba de humo (`version.json` y `schemaVersion` de `ml_slots`). La base y el workflow de n8n no los toca el CI. Volver atrás: revertir el commit en `main`.
