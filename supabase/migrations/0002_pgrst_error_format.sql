-- ============================================================================
-- Mountain Lords · Migracion 0002 · formato de los errores para PostgREST + purga de pruebas
-- IDEMPOTENTE. Se pega en el SQL Editor DESPUES de la 0001.
--
-- Arregla: `mountain_lords.fail()` metia `details` como OBJETO json y PostgREST exige que `details` y
-- `hint` sean TEXTO, asi que cada error de la API (400/409/422/429) acababa en 500 PGRST121.
-- Ahora `details` va como JSON serializado en texto (el front lo parsea) y no hay `hint`.
-- Anade ml_admin_purge_test: borra las reservas de prueba (usuario con prefijo `zz.smoke.`) con sus avisos.
-- ============================================================================

create or replace function mountain_lords.fail(p_status int, p_code text, p_message text, p_details jsonb default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise sqlstate 'PGRST' using
    message = jsonb_strip_nulls(jsonb_build_object('code', p_code, 'message', p_message, 'details', p_details::text))::text,
    detail = jsonb_build_object('status', p_status)::text;
end $$;

-- Borra las reservas de PRUEBA (discord_username que empieza por `zz.smoke.`). Los avisos caen en cascada y el
-- limite por IP se calcula sobre las reservas, asi que tampoco queda rastro de el. Solo con la clave de admin.
create or replace function public.ml_admin_purge_test(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_auth jsonb := mountain_lords.admin_auth(p_key);
  v_n int;
begin
  if v_auth is not null then return v_auth; end if;
  delete from mountain_lords.booking where discord_username like 'zz.smoke.%';
  get diagnostics v_n = row_count;
  return jsonb_build_object('purged', v_n);
end $$;

revoke execute on function public.ml_admin_purge_test(text) from public, anon, authenticated, service_role;
grant execute on function public.ml_admin_purge_test(text) to anon, authenticated;
