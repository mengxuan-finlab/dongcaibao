begin;

create table if not exists public.company_saved_reports (
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  saved_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
create table if not exists public.company_report_reservations (
  request_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  unique (user_id, symbol)
);
alter table public.company_saved_reports enable row level security;
alter table public.company_report_reservations enable row level security;
revoke all on public.company_saved_reports, public.company_report_reservations from public, anon, authenticated;
grant select, insert, update, delete on public.company_saved_reports, public.company_report_reservations to service_role;

-- Sunday midnight in Taipei, independent of the backend's timezone.
create or replace function public.company_research_week_start()
returns timestamptz language sql stable set search_path = public as $$
  select (date_trunc('week', (now() at time zone 'Asia/Taipei') + interval '1 day') - interval '1 day') at time zone 'Asia/Taipei';
$$;

create or replace function public.company_library_state(p_user_id uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('limit', (case when exists (select 1 from public.profiles where id = p_user_id and lower(plan) in ('plus', 'pro')) then 5 else 3 end), 'weeklyLimit', (case when exists (select 1 from public.profiles where id = p_user_id and lower(plan) in ('plus', 'pro')) then 5 else 3 end),
    'used', (select count(*) from public.usage_logs where user_id = p_user_id and action = 'company_intro' and created_at >= public.company_research_week_start()),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('symbol', symbol, 'savedAt', saved_at) order by saved_at desc)
      from public.company_saved_reports where user_id = p_user_id), '[]'::jsonb));
$$;

create or replace function public.company_library_claim(p_user_id uuid, p_symbol text, p_request_id uuid)
returns jsonb language plpgsql set search_path = public as $$
declare v_payload jsonb; v_saved integer; v_pending integer; v_used integer; v_limit integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('company-library:' || p_user_id::text, 0));
  select payload into v_payload from public.company_saved_reports where user_id = p_user_id and symbol = p_symbol;
  if found then return jsonb_build_object('status', 'saved', 'payload', v_payload); end if;
  delete from public.company_report_reservations where user_id = p_user_id and expires_at <= now();
  if exists (select 1 from public.company_report_reservations where user_id = p_user_id and symbol = p_symbol) then
    return jsonb_build_object('status', 'busy');
  end if;
  select count(*) into v_saved from public.company_saved_reports where user_id = p_user_id;
  select count(*) into v_pending from public.company_report_reservations where user_id = p_user_id;
  select count(*) into v_used from public.usage_logs where user_id = p_user_id and action = 'company_intro' and created_at >= public.company_research_week_start();
  v_limit := (case when exists (select 1 from public.profiles where id = p_user_id and lower(plan) in ('plus', 'pro')) then 5 else 3 end);
  if v_saved + v_pending >= v_limit then return jsonb_build_object('status', 'full', 'limit', v_limit); end if;
  if v_used + v_pending >= v_limit then return jsonb_build_object('status', 'quota', 'limit', v_limit); end if;
  insert into public.company_report_reservations(request_id, user_id, symbol) values (p_request_id, p_user_id, p_symbol);
  return jsonb_build_object('status', 'reserved');
end;
$$;

create or replace function public.company_library_finish(p_request_id uuid, p_payload jsonb)
returns void language plpgsql set search_path = public as $$
declare v_user_id uuid; v_symbol text;
begin
  select user_id into v_user_id from public.company_report_reservations where request_id = p_request_id;
  if not found then raise exception 'COMPANY_RESERVATION_MISSING'; end if;
  perform pg_advisory_xact_lock(hashtextextended('company-library:' || v_user_id::text, 0));
  select symbol into v_symbol from public.company_report_reservations where request_id = p_request_id and expires_at > now();
  if not found then raise exception 'COMPANY_RESERVATION_EXPIRED'; end if;
  insert into public.company_saved_reports(user_id, symbol, payload) values (v_user_id, v_symbol, p_payload);
  insert into public.usage_logs(user_id, action) values (v_user_id, 'company_intro');
  delete from public.company_report_reservations where request_id = p_request_id;
end;
$$;

create or replace function public.company_library_remove(p_user_id uuid, p_symbol text)
returns void language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('company-library:' || p_user_id::text, 0));
  delete from public.company_saved_reports where user_id = p_user_id and symbol = p_symbol;
end;
$$;

revoke all on function public.company_research_week_start(), public.company_library_state(uuid),
  public.company_library_claim(uuid,text,uuid), public.company_library_finish(uuid,jsonb), public.company_library_remove(uuid,text) from public, anon, authenticated;
grant execute on function public.company_research_week_start(), public.company_library_state(uuid),
  public.company_library_claim(uuid,text,uuid), public.company_library_finish(uuid,jsonb), public.company_library_remove(uuid,text) to service_role;
commit;
