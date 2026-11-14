begin;

-- Free members: three saved reports/tracked stocks; company research also three per week.
-- Plus/Pro keep five. Existing reports and usage history are not deleted.

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

create or replace function public.start_financial_report(p_user uuid, p_tracking text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  stock public.tracked_stocks%rowtype;
  job public.financial_report_jobs%rowtype;
  usage_count integer;
  today date := (now() at time zone 'Asia/Taipei')::date;
  ready_status text;
  target_url text;
begin
  -- Use one short transaction lock for admission, claim and completion so
  -- capacity checks and row-lock ordering are consistent across replicas.
  perform pg_advisory_xact_lock(814902);
  select * into stock from public.tracked_stocks
    where id::text = p_tracking and user_id = p_user for update;
  if not found then raise exception 'REPORT_NOT_FOUND'; end if;
  if stock.symbol !~ '^[A-Z][A-Z0-9.^-]{0,19}$' and stock.symbol !~ '^[0-9]{4}(\.TW|\.TWO)?$' then
    raise exception 'FINANCIAL_SYMBOL_REQUIRED';
  end if;
  ready_status := case when stock.symbol ~ '^[0-9]{4}(\.TW|\.TWO)?$' then 'tw_ready' else 'ready' end;
  target_url := 'https://hims-chart.vercel.app/' || case when ready_status = 'tw_ready' then 'tw_report.html' else '' end
    || '?symbol=' || stock.symbol;
  if (select count(*) from public.tracked_stocks where user_id = p_user) > (case when exists (select 1 from public.profiles where id = p_user and lower(plan) in ('plus', 'pro')) then 5 else 3 end) then
    raise exception 'TRACKING_LIMIT';
  end if;
  if stock.status in ('ready', 'tw_ready') and stock.report_json is not null
    and coalesce(stock.report_json ->> 'as_of', '') >= to_char(now() - interval '3 days', 'YYYY-MM-DD') then
    return jsonb_build_object('state', 'ready');
  end if;
  select * into job from public.financial_report_jobs where user_id = p_user and symbol = stock.symbol for update;
  if found then
    if job.state in ('queued', 'running') and job.tracking_id <> p_tracking then
      raise exception 'REPORT_ALREADY_RUNNING';
    end if;
    if job.state in ('queued', 'running') then return jsonb_build_object('state', job.state); end if;
    if job.state = 'ready' and job.result is not null and job.updated_at > now() - interval '3 days' then
      update public.tracked_stocks set report_json = job.result, summary = job.summary, status = ready_status,
        report_url = target_url
        where id::text = p_tracking and user_id = p_user;
      return jsonb_build_object('state', 'ready');
    end if;
    if job.updated_at > now() - interval '1 minute' then raise exception 'REPORT_RETRY_COOLDOWN'; end if;
    if job.attempt_day = today and job.daily_attempts >= 3 then raise exception 'REPORT_DAILY_LIMIT'; end if;
  end if;
  select coalesce(sum(daily_attempts), 0) into usage_count from public.financial_report_jobs
    where user_id = p_user and attempt_day = today;
  if usage_count >= 20 then raise exception 'REPORT_DAILY_LIMIT'; end if;
  if (select count(*) from public.financial_report_jobs where state in ('queued', 'running')) >= 24 then
    raise exception 'REPORT_QUEUE_FULL';
  end if;
  insert into public.financial_report_jobs (user_id, symbol, tracking_id)
    values (p_user, stock.symbol, p_tracking)
    on conflict (user_id, symbol) do update set tracking_id = p_tracking, state = 'queued',
      phase = 'queued', lease_token = null, lease_until = null, attempts = 0, updated_at = now();
  update public.tracked_stocks set status = 'financial_queued' where id::text = p_tracking and user_id = p_user;
  return jsonb_build_object('state', 'queued');
end;
$$;

create or replace function public.enforce_financial_tracking_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_limit integer;
begin
  -- Serialize direct Supabase inserts with report admission.
  perform pg_advisory_xact_lock(814902);
  v_limit := (case when exists (select 1 from public.profiles where id = new.user_id and lower(plan) in ('plus', 'pro')) then 5 else 3 end);
  if (select count(*) from public.tracked_stocks where user_id = new.user_id) >= v_limit then
    raise exception '已達 % 檔追蹤上限，請先移除一檔再新增。', v_limit using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_financial_tracking_limit() from public, anon, authenticated;
drop trigger if exists enforce_financial_tracking_limit on public.tracked_stocks;
create trigger enforce_financial_tracking_limit before insert on public.tracked_stocks
  for each row execute function public.enforce_financial_tracking_limit();

commit;
