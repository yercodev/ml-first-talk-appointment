-- ============================================================================
-- Mountain Lords · Migracion 0003 · pg_safeupdate + fecha de cierre de la convocatoria
-- IDEMPOTENTE. Se pega en el SQL Editor DESPUES de la 0001 y la 0002.
--
--  1) Supabase carga `pg_safeupdate` en las peticiones de PostgREST: rechaza UPDATE/DELETE sin WHERE
--     (error 21000 «UPDATE requires a WHERE clause»). ml_integration_pending hacia
--     `update mountain_lords.integration_run set last_run_at = ...` sin WHERE y fallaba con 400. Ahora lleva `where id`.
--  2) Cierre de la convocatoria: `settings.booking_until` (date, null = sin cierre). Se deja en 2026-11-15
--     (domingo 15 de noviembre, incluido, hora Colombia) la PRIMERA vez que se aplica. ml_slots no ofrece dias
--     posteriores y devuelve `bookingUntil` y `closed`; ml_book rechaza cupos posteriores con 422 reason "closed";
--     ml_admin_agenda devuelve `bookingUntil`. Para cambiarlo despues:
--       update mountain_lords.settings set booking_until = '2026-11-22' where id;   -- o null para quitar el cierre
-- ============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'mountain_lords' and table_name = 'settings' and column_name = 'booking_until') then
    alter table mountain_lords.settings add column booking_until date;
    update mountain_lords.settings set booking_until = date '2026-11-15' where id;
  end if;
end $$;

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
    'bookingUntil', s.booking_until::text,
    'closed', (s.booking_until is not null and not exists (
                 select 1 from mountain_lords.gen_slots(v_now) g2
                 where g2.day <= s.booking_until and g2.slot_start >= v_now + s.min_lead_minutes * interval '1 minute')),
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
        where s.booking_until is null or g.day <= s.booking_until
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
  elsif s.booking_until is not null and v_local::date > s.booking_until then
    perform mountain_lords.fail(422, 'slot_not_bookable', 'La convocatoria cerró.', jsonb_build_object('reason', 'closed'));
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
    'bookingUntil', (select booking_until::text from mountain_lords.settings),
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
  -- Con WHERE explicito: pg_safeupdate (Supabase) rechaza UPDATE/DELETE sin WHERE en las peticiones de PostgREST.
  update mountain_lords.integration_run set last_run_at = v_now where id;

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
