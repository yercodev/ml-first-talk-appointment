-- ============================================================================
-- Mountain Lords · Agenda de primera charla · Migracion 0001 (HU-001)
-- IDEMPOTENTE: se puede aplicar dos veces. La aplica Yerco en el SQL Editor de
-- staging (proyecto dojgxfotawtxitgcppyn) ANTES de publicar un front que la necesite.
--
--   * Los datos viven en el esquema `mountain_lords`, que NO se expone por PostgREST.
--   * La API son 10 funciones `public.ml_*` SECURITY DEFINER con search_path vacio.
--   * Supabase da EXECUTE por defecto a anon/authenticated/service_role sobre las funciones
--     nuevas de `public`: aqui se REVOCA explicitamente y se concede solo lo justo.
--   * Toda la logica (grilla, reglas, textos de Discord, limpieza) vive en SQL; n8n solo transporta.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin
  -- Si pgcrypto ya estuviera instalado en otro esquema, `create extension if not exists` no haria nada
  -- y las funciones fallarian mas tarde con un error confuso: se avisa aqui.
  if to_regprocedure('extensions.crypt(text,text)') is null or to_regprocedure('extensions.digest(text,text)') is null then
    raise exception 'pgcrypto tiene que estar instalado en el esquema extensions (create extension pgcrypto with schema extensions)';
  end if;
end $$;

create schema if not exists mountain_lords;
revoke all on schema mountain_lords from public, anon, authenticated;

-- ---------------------------------------------------------------- Tablas

create table if not exists mountain_lords.settings (
  id                           boolean primary key default true check (id),
  utc_offset                   text    not null default '-05:00',
  day_start                    time    not null default '16:30',
  day_end                      time    not null default '22:30',
  slot_minutes                 int     not null default 40 check (slot_minutes > 0),
  window_days                  int     not null default 14 check (window_days > 0),
  min_lead_minutes             int     not null default 60,
  max_bookings_per_ip_per_day  int     not null default 3,
  retention_days               int     not null default 30,
  reminder_minutes             int     not null default 15,
  daily_agenda_time            time    not null default '16:00',
  lease_seconds                int     not null default 120,
  guild_id                     text    not null default '1422085223348179028',
  ml_temp_role_id              text    not null default '1567723288900149430',
  ml_temp_text_channel_id      text    not null default '1567723300287815803',
  ml_temp_voice_channel_id     text    not null default '1567723301856481300',
  admin_discord_user_id        text    not null default '224261961502818305',
  discord_invite_url           text    not null default 'https://discord.gg/9m2MhhgPHv',
  public_base_url              text    not null default 'https://yercodev.github.io/ml-first-talk-appointment/',
  ip_hash_salt                 text    not null default encode(extensions.gen_random_bytes(16), 'hex'),
  privacy_version              text    not null default '2026-11-10',
  admin_key_hash               text    not null default '',
  allow_fake_now               boolean not null default false,
  fake_now                     timestamptz
);
insert into mountain_lords.settings (id) values (true) on conflict (id) do nothing;

create table if not exists mountain_lords.booking (
  id                 uuid primary key default extensions.gen_random_uuid(),
  slot_start         timestamptz not null,
  slot_end           timestamptz not null,
  discord_username   text not null,
  display_name       text not null,
  riot_id            text,
  main_role          text,
  message            text,
  status             text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancelled_by       text check (cancelled_by in ('aspirant', 'admin')),
  cancelled_at       timestamptz,
  manage_token_hash  text not null unique,
  ip_hash            text,
  created_at         timestamptz not null default now(),
  discord_user_id    text,
  role_assigned_at   timestamptz,
  welcome_sent_at    timestamptz,
  privacy_version    text
);
alter table mountain_lords.settings add column if not exists privacy_version text not null default '2026-11-10';
alter table mountain_lords.booking add column if not exists privacy_version text;
-- D3: un cupo solo puede tener UNA reserva confirmada (barrera final contra las carreras).
create unique index if not exists booking_one_per_slot on mountain_lords.booking (slot_start) where status = 'confirmed';
create index if not exists booking_user_idx on mountain_lords.booking (discord_username, status);
create index if not exists booking_ip_idx on mountain_lords.booking (ip_hash);

create table if not exists mountain_lords.slot_block (
  slot_start timestamptz primary key,
  created_at timestamptz not null default now()
);

create table if not exists mountain_lords.notification (
  id              bigint generated always as identity primary key,
  dedupe_key      text not null unique,
  kind            text not null,
  booking_id      uuid references mountain_lords.booking (id) on delete cascade,
  target          jsonb not null,
  content         text not null,
  allowed_mentions jsonb not null,
  flags           int,
  status          text not null default 'pending' check (status in ('pending', 'leased', 'sent', 'failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index if not exists notification_status_idx on mountain_lords.notification (status, next_attempt_at);

create table if not exists mountain_lords.admin_fail (
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index if not exists admin_fail_idx on mountain_lords.admin_fail (ip_hash, at);

create table if not exists mountain_lords.integration_run (
  id          boolean primary key default true check (id),
  last_run_at timestamptz
);
insert into mountain_lords.integration_run (id) values (true) on conflict (id) do nothing;

alter table mountain_lords.settings        enable row level security;
alter table mountain_lords.booking         enable row level security;
alter table mountain_lords.slot_block      enable row level security;
alter table mountain_lords.notification    enable row level security;
alter table mountain_lords.admin_fail      enable row level security;
alter table mountain_lords.integration_run enable row level security;
revoke all on all tables in schema mountain_lords from public, anon, authenticated;

-- ------------------------------------------------------- Helpers privados

-- Reloj. Solo cambia si allow_fake_now esta a true (los tests); en staging es false.
create or replace function mountain_lords.clock() returns timestamptz
language sql stable set search_path = '' as $$
  select case when s.allow_fake_now and s.fake_now is not null then s.fake_now else pg_catalog.now() end
  from mountain_lords.settings s
$$;

create or replace function mountain_lords.off() returns interval
language sql stable set search_path = '' as $$
  select s.utc_offset::interval from mountain_lords.settings s
$$;

create or replace function mountain_lords.to_local(p_ts timestamptz) returns timestamp
language sql stable set search_path = '' as $$
  select (p_ts at time zone 'UTC') + mountain_lords.off()
$$;

create or replace function mountain_lords.from_local(p_l timestamp) returns timestamptz
language sql stable set search_path = '' as $$
  select (p_l - mountain_lords.off()) at time zone 'UTC'
$$;

create or replace function mountain_lords.iso(p_ts timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

-- Cupos de la ventana (sin filtrar). `day` es el dia LOCAL de la agenda.
create or replace function mountain_lords.gen_slots(p_now timestamptz)
returns table (day date, slot_start timestamptz, slot_end timestamptz)
language sql stable set search_path = '' as $$
  select d.day,
         mountain_lords.from_local(d.day + s.day_start + (i * s.slot_minutes) * interval '1 minute'),
         mountain_lords.from_local(d.day + s.day_start + ((i + 1) * s.slot_minutes) * interval '1 minute')
  from mountain_lords.settings s,
       lateral generate_series(0, s.window_days - 1) as n,
       lateral (select mountain_lords.to_local(p_now)::date + n as day) d,
       lateral generate_series(0, ((extract(epoch from (s.day_end - s.day_start)) / 60)::int / s.slot_minutes) - 1) as i
$$;

-- Fechas en espanol con listas propias (to_char TM depende del lc_time del servidor).
create or replace function mountain_lords.fmt_time(p_ts timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(l, 'FMHH12:MI') || case when extract(hour from l) < 12 then ' AM' else ' PM' end
  from (select mountain_lords.to_local(p_ts) as l) x
$$;

-- "jue 12-nov, 5:10 p. m."
create or replace function mountain_lords.fmt_short(p_ts timestamptz) returns text
language sql stable set search_path = '' as $$
  select (array['dom','lun','mar','mié','jue','vie','sáb'])[extract(dow from l)::int + 1]
      || ' ' || extract(day from l)::int || '-'
      || (array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'])[extract(month from l)::int]
      || ', ' || mountain_lords.fmt_time(p_ts)
  from (select mountain_lords.to_local(p_ts) as l) x
$$;

-- "jueves 12 de noviembre"
create or replace function mountain_lords.fmt_long_day(p_ts timestamptz) returns text
language sql stable set search_path = '' as $$
  select (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from l)::int + 1]
      || ' ' || extract(day from l)::int || ' de '
      || (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[extract(month from l)::int]
  from (select mountain_lords.to_local(p_ts) as l) x
$$;

-- "mar 10-nov"
create or replace function mountain_lords.fmt_day_short(p_ts timestamptz) returns text
language sql stable set search_path = '' as $$
  select (array['dom','lun','mar','mié','jue','vie','sáb'])[extract(dow from l)::int + 1]
      || ' ' || extract(day from l)::int || '-'
      || (array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'])[extract(month from l)::int]
  from (select mountain_lords.to_local(p_ts) as l) x
$$;

-- Escapa el markdown de Discord y neutraliza menciones/enlaces en texto del aspirante.
create or replace function mountain_lords.md_escape(p_t text) returns text
language sql immutable set search_path = '' as $$
  -- Una sola linea: sin saltos ni caracteres de control, para que el texto del aspirante no pueda
  -- forjar lineas (p. ej. una falsa cabecera del bot) en los DMs a Yerco.
  select regexp_replace(
           btrim(regexp_replace(coalesce(p_t, ''), '[[:cntrl:]]+', ' ', 'g')),
           '([\\*_~`|>#\[\]()<@:])', '\\\1', 'g')
$$;

create or replace function mountain_lords.sha256_hex(p_t text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_t, 'sha256'), 'hex')
$$;

-- Error que DESHACE la transaccion (PostgREST lo traduce al estado HTTP de `detail`).
create or replace function mountain_lords.fail(p_status int, p_code text, p_message text, p_details jsonb default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise sqlstate 'PGRST' using
    message = jsonb_build_object('code', p_code, 'message', p_message, 'details', p_details, 'hint', null)::text,
    detail = jsonb_build_object('status', p_status)::text;
end $$;

-- Error que DEJA RASTRO: responde con response.status y el cuerpo, sin RAISE.
create or replace function mountain_lords.reply_error(p_status int, p_code text, p_message text) returns jsonb
language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.set_config('response.status', p_status::text, true);
  return jsonb_build_object('code', p_code, 'message', p_message, 'details', null, 'hint', null);
end $$;

-- IP del cliente: cf-connecting-ip (no falsificable) o el primer valor de x-forwarded-for.
create or replace function mountain_lords.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare
  v_h jsonb;
begin
  begin
    v_h := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return null;
  end;
  return nullif(btrim(coalesce(v_h ->> 'cf-connecting-ip', split_part(coalesce(v_h ->> 'x-forwarded-for', ''), ',', 1))), '');
end $$;

-- Hash de la IP: el dia (hora Colombia) va dentro, asi que cambia cada dia. Sin IP: null.
create or replace function mountain_lords.ip_hash(p_ip text) returns text
language sql stable set search_path = '' as $$
  select case when p_ip is null then null else
    mountain_lords.sha256_hex(s.ip_hash_salt || ':' || mountain_lords.to_local(mountain_lords.clock())::date::text || ':' || p_ip) end
  from mountain_lords.settings s
$$;

create or replace function mountain_lords.is_grid_time(p_local timestamp) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  s mountain_lords.settings;
  v_min numeric;
begin
  select * into s from mountain_lords.settings;
  if extract(second from p_local) <> 0 then return false; end if;
  v_min := extract(epoch from (p_local::time - s.day_start)) / 60;
  return v_min >= 0
     and v_min = floor(v_min)
     and (v_min::int % s.slot_minutes) = 0
     and (p_local::time + s.slot_minutes * interval '1 minute') <= s.day_end
     and (p_local::time + s.slot_minutes * interval '1 minute') > p_local::time;
end $$;

-- Presencia en el texto de los avisos.
create or replace function mountain_lords.data_lines(p_b mountain_lords.booking) returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(concat_ws(' · ',
           case when p_b.riot_id is not null then 'Riot ID: ' || mountain_lords.md_escape(p_b.riot_id) end,
           case when p_b.main_role is not null then 'Rol: ' || mountain_lords.md_escape(p_b.main_role) end,
           case when p_b.message is not null then 'Mensaje: ' || mountain_lords.md_escape(left(p_b.message, 200)) || case when char_length(p_b.message) > 200 then '…' else '' end end), ''), '')
$$;

-- Encola un aviso. dedupe_key unica: no se encola dos veces.
create or replace function mountain_lords.enqueue(
  p_key text, p_kind text, p_booking uuid, p_target jsonb, p_content text, p_mentions jsonb, p_flags int default null
) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_id bigint;
begin
  insert into mountain_lords.notification (dedupe_key, kind, booking_id, target, content, allowed_mentions, flags, next_attempt_at, created_at)
  values (p_key, p_kind, p_booking, p_target, p_content, p_mentions, p_flags, mountain_lords.clock(), mountain_lords.clock())
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function mountain_lords.dm_target() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('type', 'dm', 'userId', s.admin_discord_user_id) from mountain_lords.settings s
$$;

create or replace function mountain_lords.channel_target() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('type', 'channel', 'id', s.ml_temp_text_channel_id) from mountain_lords.settings s
$$;

-- DM "Nueva charla" (el aspirante todavia no esta vinculado).
create or replace function mountain_lords.enqueue_new(p_b mountain_lords.booking) returns void
language plpgsql set search_path = '' as $$
declare
  v_s mountain_lords.settings;
  v_extra text := mountain_lords.data_lines(p_b);
begin
  select * into v_s from mountain_lords.settings;
  perform mountain_lords.enqueue('new:' || p_b.id, 'new', p_b.id, mountain_lords.dm_target(),
    'Nueva charla: ' || mountain_lords.md_escape(p_b.display_name) || ' (' || mountain_lords.md_escape(p_b.discord_username) || '), '
      || mountain_lords.fmt_short(p_b.slot_start) || E'\n'
      || case when v_extra <> '' then v_extra || E'\n' else '' end
      || case when p_b.discord_user_id is null then 'Aún no tiene ML-temp.' else 'Ya tiene ML-temp.' end || E'\n'
      || 'Agenda: ' || v_s.public_base_url || 'admin.html',
    jsonb_build_object('parse', '[]'::jsonb), 4);
end $$;

-- ----------------------------------------------------------- API publica

create or replace function public.ml_slots() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  s mountain_lords.settings;
begin
  select * into s from mountain_lords.settings;
  return jsonb_build_object(
    'now', mountain_lords.iso(v_now),
    'utcOffset', s.utc_offset,
    'slotMinutes', s.slot_minutes,
    'schemaVersion', 1,
    'inviteUrl', s.discord_invite_url,
    'days', coalesce((
      select jsonb_agg(d.obj order by d.day) from (
        select g.day,
               jsonb_build_object('date', g.day::text, 'slots', jsonb_agg(jsonb_build_object(
                 'start', mountain_lords.iso(g.slot_start),
                 'end', mountain_lords.iso(g.slot_end),
                 'available', (b.id is null and bl.slot_start is null
                               and g.slot_start >= v_now + s.min_lead_minutes * interval '1 minute')
               ) order by g.slot_start)) as obj
        from mountain_lords.gen_slots(v_now) g
        left join mountain_lords.booking b on b.slot_start = g.slot_start and b.status = 'confirmed'
        left join mountain_lords.slot_block bl on bl.slot_start = g.slot_start
        group by g.day
      ) d), '[]'::jsonb));
end $$;

create or replace function public.ml_book(
  p_slot_start timestamptz,
  p_discord_username text,
  p_display_name text,
  p_riot_id text default null,
  p_main_role text default null,
  p_message text default null,
  p_privacy_accepted boolean default false,
  p_website text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  s mountain_lords.settings;
  v_det jsonb := '{}'::jsonb;
  v_user text;
  v_name text;
  v_riot text;
  v_role text;
  v_msg text;
  v_local timestamp;
  v_ip text;
  v_iph text;
  v_token text;
  v_row mountain_lords.booking;
  v_existing timestamptz;
begin
  select * into s from mountain_lords.settings;

  -- Honeypot (S5): 400 generico, sin nombrar el campo y sin guardar nada.
  if coalesce(btrim(p_website), '') <> '' then
    perform mountain_lords.fail(400, 'bad_request', 'Petición no válida.');
  end if;

  -- Usuario de Discord
  v_user := regexp_replace(lower(btrim(coalesce(p_discord_username, ''))), '^@', '');
  if v_user ~ '#[0-9]{1,4}$' then
    v_det := v_det || jsonb_build_object('discordUsername', 'Ese es el formato antiguo de Discord. Abre tu perfil y copia tu usuario actual.');
  elsif v_user !~ '^[a-z0-9_.]{2,32}$' or position('..' in v_user) > 0 then
    v_det := v_det || jsonb_build_object('discordUsername', 'Escribe tu usuario de Discord: de 2 a 32 caracteres, solo letras, números, punto y guion bajo, sin espacios.');
  end if;

  -- Nombre o nick
  v_name := btrim(coalesce(p_display_name, ''));
  if char_length(v_name) < 2 or char_length(v_name) > 32 or v_name ~ '[[:cntrl:]]' then
    v_det := v_det || jsonb_build_object('displayName', 'Escribe tu nombre o nick (de 2 a 32 caracteres).');
  end if;

  -- Riot ID (opcional)
  v_riot := nullif(btrim(coalesce(p_riot_id, '')), '');
  if v_riot is not null and (v_riot !~ '^[^#[:space:]][^#]{2,15}#[A-Za-z0-9]{3,5}$' or v_riot ~ '[[:cntrl:]]') then
    v_det := v_det || jsonb_build_object('riotId', 'El Riot ID va así: nombre#tag.');
  end if;

  -- Rol (opcional)
  v_role := nullif(lower(btrim(coalesce(p_main_role, ''))), '');
  if v_role is not null and v_role not in ('duelista', 'iniciador', 'controlador', 'centinela', 'flex') then
    v_det := v_det || jsonb_build_object('mainRole', 'Elige uno de los roles de la lista.');
  end if;

  -- Mensaje (opcional)
  v_msg := nullif(btrim(coalesce(p_message, '')), '');
  if v_msg is not null and (char_length(v_msg) > 300 or v_msg ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    v_det := v_det || jsonb_build_object('message', 'El mensaje puede tener hasta 300 caracteres.');
  end if;

  if p_privacy_accepted is not true then
    v_det := v_det || jsonb_build_object('privacyAccepted', 'Para reservar tienes que aceptar el aviso de privacidad.');
  end if;
  if p_slot_start is null then
    v_det := v_det || jsonb_build_object('slotStart', 'Elige un horario.');
  end if;
  if v_det <> '{}'::jsonb then
    perform mountain_lords.fail(400, 'validation_error', 'Revisa los datos del formulario.', v_det);
  end if;

  -- Reglas del cupo, en este orden: grilla, ventana, pasado, antelacion.
  v_local := mountain_lords.to_local(p_slot_start);
  if not mountain_lords.is_grid_time(v_local) then
    perform mountain_lords.fail(422, 'slot_not_bookable', 'Ese horario no existe.', jsonb_build_object('reason', 'outside_schedule'));
  elsif v_local::date >= mountain_lords.to_local(v_now)::date + s.window_days then
    perform mountain_lords.fail(422, 'slot_not_bookable', 'Ese horario está fuera de la ventana.', jsonb_build_object('reason', 'beyond_window'));
  elsif p_slot_start <= v_now then
    perform mountain_lords.fail(422, 'slot_not_bookable', 'Ese horario ya pasó.', jsonb_build_object('reason', 'past'));
  elsif p_slot_start < v_now + s.min_lead_minutes * interval '1 minute' then
    perform mountain_lords.fail(422, 'slot_not_bookable', 'Ese horario es demasiado pronto.', jsonb_build_object('reason', 'too_soon'));
  end if;

  -- D2: las peticiones del mismo usuario se ponen en fila.
  perform pg_advisory_xact_lock(hashtextextended('ml:' || v_user, 0));

  if exists (select 1 from mountain_lords.slot_block where slot_start = p_slot_start)
     or exists (select 1 from mountain_lords.booking where slot_start = p_slot_start and status = 'confirmed') then
    perform mountain_lords.fail(409, 'slot_taken', 'Alguien acaba de tomar ese horario.');
  end if;

  select b.slot_start into v_existing from mountain_lords.booking b
   where b.discord_username = v_user and b.status = 'confirmed' and b.slot_end > v_now limit 1;
  if v_existing is not null then
    perform mountain_lords.fail(409, 'already_booked', 'Ese usuario ya tiene una charla agendada.');
  end if;

  v_ip := mountain_lords.client_ip();
  v_iph := mountain_lords.ip_hash(v_ip);
  if v_iph is not null then
    perform pg_advisory_xact_lock(hashtextextended('ml:ip:' || v_iph, 0));
    if (select count(*) from mountain_lords.booking where ip_hash = v_iph) >= s.max_bookings_per_ip_per_day then
      perform mountain_lords.fail(429, 'rate_limited', 'Demasiadas reservas desde esta conexión hoy.');
    end if;
  end if;

  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  begin
    insert into mountain_lords.booking
      (slot_start, slot_end, discord_username, display_name, riot_id, main_role, message, manage_token_hash, ip_hash, created_at, privacy_version)
    values
      (p_slot_start, p_slot_start + s.slot_minutes * interval '1 minute', v_user, v_name, v_riot, v_role, v_msg,
       mountain_lords.sha256_hex(v_token), v_iph, v_now, s.privacy_version)
    returning * into v_row;
  exception when unique_violation then
    perform mountain_lords.fail(409, 'slot_taken', 'Alguien acaba de tomar ese horario.');
  end;

  perform mountain_lords.enqueue_new(v_row);

  return jsonb_build_object(
    'booking', jsonb_build_object(
      'id', v_row.id, 'slotStart', mountain_lords.iso(v_row.slot_start), 'slotEnd', mountain_lords.iso(v_row.slot_end),
      'discordUsername', v_row.discord_username, 'displayName', v_row.display_name,
      'riotId', v_row.riot_id, 'mainRole', v_row.main_role, 'message', v_row.message, 'status', v_row.status),
    'manageToken', v_token);
end $$;

create or replace function public.ml_booking_lookup(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_b mountain_lords.booking;
begin
  select * into v_b from mountain_lords.booking where manage_token_hash = mountain_lords.sha256_hex(coalesce(p_token, ''));
  if v_b.id is null then
    perform mountain_lords.fail(404, 'not_found', 'Este enlace no es válido o la reserva ya se borró.');
  end if;
  return jsonb_build_object('booking', jsonb_build_object(
    'id', v_b.id, 'slotStart', mountain_lords.iso(v_b.slot_start), 'slotEnd', mountain_lords.iso(v_b.slot_end),
    'discordUsername', v_b.discord_username, 'displayName', v_b.display_name,
    'status', v_b.status, 'cancelledBy', v_b.cancelled_by,
    'started', v_b.slot_start <= mountain_lords.clock()),
    'inviteUrl', (select discord_invite_url from mountain_lords.settings));
end $$;

create or replace function public.ml_booking_cancel(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  v_b mountain_lords.booking;
begin
  select * into v_b from mountain_lords.booking where manage_token_hash = mountain_lords.sha256_hex(coalesce(p_token, '')) for update;
  if v_b.id is null then
    perform mountain_lords.fail(404, 'not_found', 'Este enlace no es válido o la reserva ya se borró.');
  end if;
  if v_b.status = 'cancelled' then
    return jsonb_build_object('status', 'cancelled', 'alreadyCancelled', true);
  end if;
  if v_b.slot_start <= v_now then
    perform mountain_lords.fail(409, 'already_started', 'Esta charla ya empezó o ya pasó; no se puede cancelar.');
  end if;
  update mountain_lords.booking set status = 'cancelled', cancelled_by = 'aspirant', cancelled_at = v_now where id = v_b.id;
  -- Lo que aun no salio (bienvenida, recordatorios) ya no tiene sentido.
  delete from mountain_lords.notification where booking_id = v_b.id and status in ('pending', 'leased') and kind not in ('new');
  perform mountain_lords.enqueue('cancel:' || v_b.id, 'cancel', v_b.id, mountain_lords.dm_target(),
    'Cancelada: ' || mountain_lords.md_escape(v_b.display_name) || ' (' || mountain_lords.md_escape(v_b.discord_username) || '), '
      || mountain_lords.fmt_short(v_b.slot_start) || '. El horario queda libre.'
      || case when v_b.role_assigned_at is not null then E'\nYa tenía ML-temp y lo conserva.' else '' end,
    jsonb_build_object('parse', '[]'::jsonb), 4);
  return jsonb_build_object('status', 'cancelled', 'alreadyCancelled', false);
end $$;

-- ----------------------------------------------------------------- Admin

-- Devuelve null si la clave es buena, o el cuerpo de error (con response.status). Sin RAISE:
-- un RAISE desharia el registro de los intentos fallidos (escenario 21).
create or replace function mountain_lords.admin_auth(p_key text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  v_iph text := coalesce(mountain_lords.ip_hash(mountain_lords.client_ip()), 'sin-ip');
  v_hash text;
begin
  select admin_key_hash into v_hash from mountain_lords.settings;
  if (select count(*) from mountain_lords.admin_fail where ip_hash = v_iph and at > v_now - interval '15 minutes') >= 10 then
    return mountain_lords.reply_error(429, 'rate_limited', 'Demasiados intentos. Espera 15 minutos.');
  end if;
  if coalesce(p_key, '') = '' or coalesce(v_hash, '') = '' or extensions.crypt(p_key, v_hash) <> v_hash then
    insert into mountain_lords.admin_fail (ip_hash, at) values (v_iph, v_now);
    return mountain_lords.reply_error(401, 'unauthorized', 'Clave incorrecta.');
  end if;
  return null;
end $$;

create or replace function public.ml_admin_agenda(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_auth jsonb := mountain_lords.admin_auth(p_key);
  v_now timestamptz := mountain_lords.clock();
begin
  if v_auth is not null then return v_auth; end if;
  return jsonb_build_object(
    'now', mountain_lords.iso(v_now),
    'utcOffset', (select utc_offset from mountain_lords.settings),
    'lastIntegrationRunAt', (select mountain_lords.iso(last_run_at) from mountain_lords.integration_run),
    'failedNotifications', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'at', mountain_lords.iso(n.created_at), 'error', n.last_error) order by n.id)
      from mountain_lords.notification n where n.status = 'failed'), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(d.obj order by d.day) from (
        select g.day, jsonb_build_object('date', g.day::text, 'slots', jsonb_agg(jsonb_build_object(
          'start', mountain_lords.iso(g.slot_start),
          'end', mountain_lords.iso(g.slot_end),
          'past', g.slot_end <= v_now,
          'state', case when b.id is not null then 'booked' when bl.slot_start is not null then 'blocked' else 'free' end,
          'booking', case when b.id is null then null else jsonb_build_object(
            'id', b.id, 'displayName', b.display_name, 'discordUsername', b.discord_username, 'riotId', b.riot_id,
            'mainRole', b.main_role, 'message', b.message, 'createdAt', mountain_lords.iso(b.created_at),
            'inServer', b.discord_user_id is not null, 'roleAssignedAt', mountain_lords.iso(b.role_assigned_at)) end
        ) order by g.slot_start)) as obj
        from mountain_lords.gen_slots(v_now) g
        left join mountain_lords.booking b on b.slot_start = g.slot_start and b.status = 'confirmed'
        left join mountain_lords.slot_block bl on bl.slot_start = g.slot_start
        group by g.day) d), '[]'::jsonb));
end $$;

create or replace function public.ml_admin_cancel(p_key text, p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_auth jsonb := mountain_lords.admin_auth(p_key);
  v_id uuid;
begin
  if v_auth is not null then return v_auth; end if;
  update mountain_lords.booking set status = 'cancelled', cancelled_by = 'admin', cancelled_at = mountain_lords.clock()
   where id = p_booking_id and status = 'confirmed' returning id into v_id;
  if v_id is null then
    perform mountain_lords.fail(404, 'not_found', 'Reserva no encontrada.');
  end if;
  -- S12: cancelar desde admin no avisa a nadie.
  delete from mountain_lords.notification where booking_id = v_id and status in ('pending', 'leased');
  return jsonb_build_object('status', 'cancelled');
end $$;

create or replace function public.ml_admin_block(p_key text, p_slot_start timestamptz default null, p_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_auth jsonb := mountain_lords.admin_auth(p_key);
  v_now timestamptz := mountain_lords.clock();
  v_blocked int := 0;
  v_skipped int := 0;
  r record;
begin
  if v_auth is not null then return v_auth; end if;
  if (p_slot_start is null) = (p_date is null) then
    perform mountain_lords.fail(400, 'validation_error', 'Indica un cupo o un día.');
  end if;
  if p_slot_start is not null then
    if not exists (select 1 from mountain_lords.gen_slots(v_now) g where g.slot_start = p_slot_start and g.slot_end > v_now) then
      perform mountain_lords.fail(422, 'slot_not_bookable', 'Ese cupo no existe en la agenda.', jsonb_build_object('reason', 'outside_schedule'));
    end if;
    if exists (select 1 from mountain_lords.booking where slot_start = p_slot_start and status = 'confirmed') then
      perform mountain_lords.fail(409, 'slot_booked', 'Ese horario tiene una charla. Cancélala primero si quieres bloquearlo.');
    end if;
    insert into mountain_lords.slot_block (slot_start) values (p_slot_start) on conflict do nothing;
    return jsonb_build_object('blocked', 1, 'skippedBooked', 0);
  end if;
  for r in select g.slot_start, g.slot_end from mountain_lords.gen_slots(v_now) g where g.day = p_date and g.slot_end > v_now loop
    if exists (select 1 from mountain_lords.booking where slot_start = r.slot_start and status = 'confirmed') then
      v_skipped := v_skipped + 1;
    else
      insert into mountain_lords.slot_block (slot_start) values (r.slot_start) on conflict do nothing;
      v_blocked := v_blocked + 1;
    end if;
  end loop;
  return jsonb_build_object('blocked', v_blocked, 'skippedBooked', v_skipped);
end $$;

create or replace function public.ml_admin_unblock(p_key text, p_slot_start timestamptz default null, p_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_auth jsonb := mountain_lords.admin_auth(p_key);
  v_n int;
begin
  if v_auth is not null then return v_auth; end if;
  if (p_slot_start is null) = (p_date is null) then
    perform mountain_lords.fail(400, 'validation_error', 'Indica un cupo o un día.');
  end if;
  if p_slot_start is not null then
    delete from mountain_lords.slot_block where slot_start = p_slot_start;
  else
    delete from mountain_lords.slot_block where mountain_lords.to_local(slot_start)::date = p_date;
  end if;
  get diagnostics v_n = row_count;
  return jsonb_build_object('unblocked', v_n);
end $$;

-- ----------------------------------------------------------- Integracion

-- Avisos listos para enviar (reclama el lease de los que devuelve).
create or replace function mountain_lords.lease_notifications() returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  v_lease int;
  v_out jsonb;
begin
  select lease_seconds into v_lease from mountain_lords.settings;
  with picked as (
    select id from mountain_lords.notification
    where attempts < 5 and (
      (status = 'pending' and next_attempt_at <= v_now) or (status = 'leased' and lease_until <= v_now))
    order by id for update skip locked
  ), upd as (
    update mountain_lords.notification n set status = 'leased', lease_until = v_now + v_lease * interval '1 second'
    from picked where n.id = picked.id
    returning n.id, n.kind, n.target, n.content, n.allowed_mentions, n.flags
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'target', target, 'content', content,
           'allowedMentions', allowed_mentions, 'flags', flags) order by id), '[]'::jsonb) into v_out from upd;
  return v_out;
end $$;

create or replace function mountain_lords.config_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('guildId', guild_id, 'roleId', ml_temp_role_id, 'textChannelId', ml_temp_text_channel_id,
           'voiceChannelId', ml_temp_voice_channel_id, 'adminDiscordUserId', admin_discord_user_id,
           'inviteUrl', discord_invite_url)
  from mountain_lords.settings
$$;

create or replace function mountain_lords.pending_core() returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  s mountain_lords.settings;
  v_today date;
  v_cleaned int := 0;
  v_n int;
  v_lines text;
  v_count int;
  v_agenda_cut timestamptz;
begin
  select * into s from mountain_lords.settings;
  v_today := mountain_lords.to_local(v_now)::date;
  update mountain_lords.integration_run set last_run_at = v_now;

  -- Limpieza (D10): reservas 30 dias despues de que termino la charla (tambien las canceladas).
  delete from mountain_lords.booking where slot_end + s.retention_days * interval '1 day' < v_now;
  get diagnostics v_n = row_count; v_cleaned := v_cleaned + v_n;
  delete from mountain_lords.slot_block where mountain_lords.to_local(slot_start)::date < v_today;
  get diagnostics v_n = row_count; v_cleaned := v_cleaned + v_n;
  delete from mountain_lords.admin_fail where at < v_now - interval '1 day';
  get diagnostics v_n = row_count; v_cleaned := v_cleaned + v_n;
  delete from mountain_lords.notification where status in ('sent', 'failed') and booking_id is null and created_at < v_now - interval '30 days';

  -- Agenda del dia (S14): primera ejecucion entre daily_agenda_time y day_end, solo si hay charlas.
  v_agenda_cut := mountain_lords.from_local(v_today + s.day_end);
  if mountain_lords.to_local(v_now)::time >= s.daily_agenda_time and v_now < v_agenda_cut
     and not exists (select 1 from mountain_lords.notification where dedupe_key = 'agenda:' || v_today::text) then
    select count(*), string_agg(
        mountain_lords.fmt_time(b.slot_start) || ' · ' || mountain_lords.md_escape(b.display_name)
        || ' (' || mountain_lords.md_escape(b.discord_username) || ') · ML-temp: '
        || case when b.discord_user_id is not null then 'sí' else 'no' end, E'\n' order by b.slot_start)
      into v_count, v_lines
      from mountain_lords.booking b
     where b.status = 'confirmed' and mountain_lords.to_local(b.slot_start)::date = v_today;
    if v_count > 0 then
      perform mountain_lords.enqueue('agenda:' || v_today::text, 'agenda', null, mountain_lords.dm_target(),
        'Agenda de hoy, ' || mountain_lords.fmt_day_short(v_now) || ': ' || v_count || case when v_count = 1 then ' charla' else ' charlas' end
          || E'\n' || v_lines, jsonb_build_object('parse', '[]'::jsonb), 4);
    end if;
  end if;

  return jsonb_build_object(
    'now', mountain_lords.iso(v_now),
    'config', mountain_lords.config_json(),
    'linkCandidates', coalesce((
      select jsonb_agg(jsonb_build_object('bookingId', b.id, 'discordUsername', b.discord_username) order by b.slot_start)
      from mountain_lords.booking b where b.status = 'confirmed' and b.discord_user_id is null and b.slot_end > v_now), '[]'::jsonb),
    'presenceChecks', coalesce((
      select jsonb_agg(jsonb_build_object('bookingId', b.id, 'discordUserId', b.discord_user_id) order by b.slot_start)
      from mountain_lords.booking b
      where b.status = 'confirmed' and b.discord_user_id is not null
        and b.slot_start > v_now and b.slot_start - s.reminder_minutes * interval '1 minute' <= v_now
        and not exists (select 1 from mountain_lords.notification n where n.dedupe_key = 'reminder-dm:' || b.id)), '[]'::jsonb),
    'notifications', mountain_lords.lease_notifications(),
    'cleaned', v_cleaned);
end $$;

create or replace function public.ml_integration_pending(p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_out jsonb;
begin
  if p_dry_run then
    -- Se calcula todo igual y se deshace: ni leases, ni avisos, ni borrados.
    begin
      v_out := mountain_lords.pending_core();
      raise exception 'dry run' using errcode = 'P0DRY';
    exception when sqlstate 'P0DRY' then
      null;
    end;
    return v_out;
  end if;
  return mountain_lords.pending_core();
end $$;

create or replace function mountain_lords.ack_core(p_payload jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := mountain_lords.clock();
  s mountain_lords.settings;
  r jsonb;
  v_n mountain_lords.notification;
  v_b mountain_lords.booking;
  v_wait interval;
  v_present boolean;
  v_listed boolean := coalesce((p_payload ->> 'membersListed')::boolean, false);
  v_linked uuid[] := '{}';
  v_attempted uuid[] := '{}';
  v_presence jsonb := '{}'::jsonb;
  v_extra text;
  v_voice text;
begin
  select * into s from mountain_lords.settings;
  v_voice := s.ml_temp_voice_channel_id;

  -- a) Resultados de los envios
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'results', '[]'::jsonb)) loop
    select * into v_n from mountain_lords.notification where id = (r ->> 'notificationId')::bigint;
    continue when v_n.id is null or v_n.status = 'sent';
    if coalesce((r ->> 'ok')::boolean, false) then
      update mountain_lords.notification set status = 'sent', sent_at = v_now, lease_until = null, last_error = null where id = v_n.id;
      if v_n.kind = 'welcome' then
        update mountain_lords.booking set welcome_sent_at = v_now where id = v_n.booking_id;
      end if;
    else
      -- S23: esperas de 1, 2, 4 y 8 min, o la de retry_after si es mayor; al 5.º fallo, "fallido".
      v_wait := greatest(power(2, v_n.attempts)::int * interval '1 minute',
                         ceil(coalesce((r ->> 'retryAfterSeconds')::numeric, 0))::int * interval '1 second');
      update mountain_lords.notification
         set attempts = attempts + 1,
             status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
             next_attempt_at = v_now + v_wait, lease_until = null, last_error = left(r ->> 'error', 300)
       where id = v_n.id;
    end if;
  end loop;

  -- b) Vinculos: solo si el rol quedo puesto (la bienvenida no sale antes).
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'links', '[]'::jsonb)) loop
    if not coalesce((r ->> 'roleOk')::boolean, false) then
      v_attempted := v_attempted || (r ->> 'bookingId')::uuid; -- el rol fallo: su presencia no se afirma
      continue;
    end if;
    update mountain_lords.booking
       set discord_user_id = r ->> 'discordUserId', role_assigned_at = v_now
     where id = (r ->> 'bookingId')::uuid and status = 'confirmed' and discord_user_id is null and slot_end > v_now
     returning * into v_b;
    continue when v_b.id is null;
    v_linked := v_linked || v_b.id;
    perform mountain_lords.enqueue('joined:' || v_b.id, 'joined', v_b.id, mountain_lords.dm_target(),
      'Ya tiene ML-temp: ' || mountain_lords.md_escape(v_b.display_name) || ' (' || mountain_lords.md_escape(v_b.discord_username)
        || '). Charla: ' || mountain_lords.fmt_short(v_b.slot_start) || '.',
      jsonb_build_object('parse', '[]'::jsonb), 4);
    perform mountain_lords.enqueue('welcome:' || v_b.id, 'welcome', v_b.id, mountain_lords.channel_target(),
      '<@' || v_b.discord_user_id || '> te damos la bienvenida al proceso de Mountain Lords. Tu charla con Yerco es el ' || mountain_lords.fmt_long_day(v_b.slot_start)
        || ' a las ' || mountain_lords.fmt_time(v_b.slot_start) || ' (hora Colombia; en tu hora, <t:'
        || extract(epoch from v_b.slot_start)::bigint || ':t>) en <#' || v_voice
        || '>. Aquí te avisamos ' || s.reminder_minutes || ' minutos antes.',
      jsonb_build_object('parse', '[]'::jsonb, 'users', jsonb_build_array(v_b.discord_user_id)));
  end loop;

  -- c) Presencia comprobada en esta ejecucion
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'presence', '[]'::jsonb)) loop
    v_presence := v_presence || jsonb_build_object(r ->> 'bookingId', coalesce((r ->> 'present')::boolean, false));
  end loop;

  -- d) Avisos de N min con la presencia ya conocida (solo si se pudo listar a los miembros)
  if v_listed then
    for v_b in
      select * from mountain_lords.booking b
      where b.status = 'confirmed' and b.slot_start > v_now
        and b.slot_start - s.reminder_minutes * interval '1 minute' <= v_now
        and not exists (select 1 from mountain_lords.notification n where n.dedupe_key = 'reminder-dm:' || b.id)
      order by b.slot_start
    loop
      -- Solo se afirma la presencia con datos reales de ESTA ejecucion; si no, se espera a la siguiente.
      if v_b.id = any (v_linked) then
        v_present := true;
      elsif jsonb_exists(v_presence, v_b.id::text) then
        v_present := coalesce((v_presence ->> v_b.id::text)::boolean, false);
      elsif v_b.discord_user_id is null and not (v_b.id = any (v_attempted)) then
        v_present := false; -- no vinculado y n8n listo a los miembros sin encontrarlo
      else
        continue; -- vinculado sin presencia comprobada (o rol fallido): no se inventa nada
      end if;
      v_extra := mountain_lords.data_lines(v_b);
      perform mountain_lords.enqueue('reminder-dm:' || v_b.id, 'reminder-dm', v_b.id, mountain_lords.dm_target(),
        'En ' || s.reminder_minutes || ' min: ' || mountain_lords.md_escape(v_b.display_name) || ' (' || mountain_lords.md_escape(v_b.discord_username)
          || '), ' || mountain_lords.fmt_time(v_b.slot_start) || '. Está en YercoVerse: ' || case when v_present then 'sí' else 'no' end || '.'
          || case when v_extra <> '' then E'\n' || v_extra else '' end,
        jsonb_build_object('parse', '[]'::jsonb), 4);
      if v_present and (v_b.discord_user_id is not null) then
        perform mountain_lords.enqueue('reminder-ch:' || v_b.id, 'reminder-ch', v_b.id, mountain_lords.channel_target(),
          '<@' || v_b.discord_user_id || '> tu charla con Yerco empieza en ' || s.reminder_minutes || ' minutos, a las '
            || mountain_lords.fmt_time(v_b.slot_start) || ' (hora Colombia; en tu hora, <t:'
            || extract(epoch from v_b.slot_start)::bigint || ':t>), en <#' || v_voice || '>.',
          jsonb_build_object('parse', '[]'::jsonb, 'users', jsonb_build_array(v_b.discord_user_id)));
      end if;
    end loop;
  end if;

  return jsonb_build_object('notifications', mountain_lords.lease_notifications());
end $$;

create or replace function public.ml_integration_ack(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_out jsonb;
begin
  if coalesce((p_payload ->> 'dryRun')::boolean, false) then
    begin
      v_out := mountain_lords.ack_core(p_payload);
      raise exception 'dry run' using errcode = 'P0DRY';
    exception when sqlstate 'P0DRY' then
      null;
    end;
    return v_out;
  end if;
  return mountain_lords.ack_core(p_payload);
end $$;

-- --------------------------------------------------------------- Permisos
-- Supabase concede EXECUTE por defecto a anon/authenticated/service_role en funciones nuevas de
-- `public`. Se revoca TODO de forma explicita y se concede solo lo justo.

revoke execute on function public.ml_slots() from public, anon, authenticated, service_role;
revoke execute on function public.ml_book(timestamptz, text, text, text, text, text, boolean, text) from public, anon, authenticated, service_role;
revoke execute on function public.ml_booking_lookup(text) from public, anon, authenticated, service_role;
revoke execute on function public.ml_booking_cancel(text) from public, anon, authenticated, service_role;
revoke execute on function public.ml_admin_agenda(text) from public, anon, authenticated, service_role;
revoke execute on function public.ml_admin_cancel(text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.ml_admin_block(text, timestamptz, date) from public, anon, authenticated, service_role;
revoke execute on function public.ml_admin_unblock(text, timestamptz, date) from public, anon, authenticated, service_role;
revoke execute on function public.ml_integration_pending(boolean) from public, anon, authenticated, service_role;
revoke execute on function public.ml_integration_ack(jsonb) from public, anon, authenticated, service_role;

grant execute on function public.ml_slots() to anon, authenticated;
grant execute on function public.ml_book(timestamptz, text, text, text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.ml_booking_lookup(text) to anon, authenticated;
grant execute on function public.ml_booking_cancel(text) to anon, authenticated;
grant execute on function public.ml_admin_agenda(text) to anon, authenticated;
grant execute on function public.ml_admin_cancel(text, uuid) to anon, authenticated;
grant execute on function public.ml_admin_block(text, timestamptz, date) to anon, authenticated;
grant execute on function public.ml_admin_unblock(text, timestamptz, date) to anon, authenticated;
grant execute on function public.ml_integration_pending(boolean) to service_role;
grant execute on function public.ml_integration_ack(jsonb) to service_role;

-- Las funciones internas del esquema no se llaman desde la API.
revoke execute on all functions in schema mountain_lords from public, anon, authenticated;
