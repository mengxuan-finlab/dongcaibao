begin;

-- Service-owned jobs survive Render restarts. tracking_id is text to support
-- either integer or UUID primary keys in existing tracked_stocks installations.
create table if not exists public.financial_report_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  tracking_id text not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'ready', 'failed')),
  phase text not null default 'queued',
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  attempt_day date not null default ((now() at time zone 'Asia/Taipei')::date),
  daily_attempts integer not null default 0,
  result jsonb,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists financial_report_jobs_queue_idx on public.financial_report_jobs (state, updated_at);
alter table public.financial_report_jobs enable row level security;
revoke all on public.financial_report_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.financial_report_jobs to service_role;

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
  if (select count(*) from public.tracked_stocks where user_id = p_user) > 5 then
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

create or replace function public.claim_financial_report()
returns setof public.financial_report_jobs language plpgsql security definer set search_path = '' as $$
declare
  job public.financial_report_jobs%rowtype;
  today date := (now() at time zone 'Asia/Taipei')::date;
begin
  -- A global two-job cap also applies with multiple Render instances.
  perform pg_advisory_xact_lock(814902);
  update public.financial_report_jobs j set state = 'failed', phase = 'removed', updated_at = now()
    where j.state in ('queued', 'running') and not exists
      (select 1 from public.tracked_stocks s where s.id::text = j.tracking_id and s.user_id = j.user_id and s.symbol = j.symbol);
  update public.tracked_stocks s set status = 'financial_error' from public.financial_report_jobs j
    where s.id::text = j.tracking_id and s.user_id = j.user_id and s.symbol = j.symbol and j.state = 'queued'
      and (select coalesce(sum(b.daily_attempts), 0) from public.financial_report_jobs b where b.user_id = j.user_id and b.attempt_day = today) >= 20;
  update public.financial_report_jobs j set state = 'failed', phase = 'daily_limit', updated_at = now()
    where j.state = 'queued' and (select coalesce(sum(b.daily_attempts), 0) from public.financial_report_jobs b
      where b.user_id = j.user_id and b.attempt_day = today) >= 20;
  update public.tracked_stocks s set status = 'financial_error'
    from public.financial_report_jobs j where s.id::text = j.tracking_id and s.user_id = j.user_id
      and s.symbol = j.symbol and j.state = 'running' and j.lease_until < now() and j.attempts >= 3;
  update public.financial_report_jobs set state = 'failed', phase = 'interrupted', updated_at = now()
    where state = 'running' and lease_until < now() and attempts >= 3;
  if (select count(*) from public.financial_report_jobs where state = 'running' and lease_until > now()) >= 2 then return; end if;
  select j.* into job from public.financial_report_jobs j
    where (j.state = 'queued' or (j.state = 'running' and j.lease_until < now()))
      and j.attempts < 3 and (j.attempt_day <> today or j.daily_attempts < 3)
      and (select coalesce(sum(b.daily_attempts), 0) from public.financial_report_jobs b
        where b.user_id = j.user_id and b.attempt_day = today) < 20
      and exists (select 1 from public.tracked_stocks s where s.id::text = j.tracking_id and s.user_id = j.user_id and s.symbol = j.symbol)
    order by j.updated_at for update of j skip locked limit 1;
  if not found then return; end if;
  update public.financial_report_jobs set state = 'running', phase = 'fetching', lease_token = gen_random_uuid(),
    lease_until = now() + interval '4 minutes', attempts = attempts + 1,
    daily_attempts = case when attempt_day = today then daily_attempts + 1 else 1 end,
    attempt_day = today, updated_at = now() where id = job.id returning * into job;
  update public.tracked_stocks set status = 'financial_running' where id::text = job.tracking_id and user_id = job.user_id;
  return next job;
end;
$$;

create or replace function public.finish_financial_report(p_job uuid, p_lease uuid, p_result jsonb, p_summary text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.financial_report_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(814902);
  select * into job from public.financial_report_jobs where id = p_job and lease_token = p_lease
    and state = 'running' and lease_until > now() for update;
  if not found then return false; end if;
  update public.tracked_stocks set report_json = p_result, summary = p_summary,
    status = case when job.symbol ~ '^[0-9]{4}(\.TW|\.TWO)?$' then 'tw_ready' else 'ready' end,
    report_url = 'https://hims-chart.vercel.app/' || case when job.symbol ~ '^[0-9]{4}(\.TW|\.TWO)?$' then 'tw_report.html' else '' end
      || '?symbol=' || job.symbol
    where id::text = job.tracking_id and user_id = job.user_id and symbol = job.symbol;
  if not found then
    update public.financial_report_jobs set state = 'failed', phase = 'removed', updated_at = now() where id = job.id;
    return false;
  end if;
  update public.financial_report_jobs set state = 'ready', phase = 'complete', result = p_result,
    summary = p_summary, lease_until = null, updated_at = now() where id = job.id;
  return true;
end;
$$;

create or replace function public.fail_financial_report(p_job uuid, p_lease uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare job public.financial_report_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(814902);
  select * into job from public.financial_report_jobs where id = p_job and lease_token = p_lease
    and state = 'running' for update;
  if not found then return; end if;
  update public.financial_report_jobs set state = 'failed', phase = 'failed', lease_until = null, updated_at = now() where id = job.id;
  update public.tracked_stocks set status = 'financial_error'
    where id::text = job.tracking_id and user_id = job.user_id and symbol = job.symbol;
end;
$$;

revoke all on function public.start_financial_report(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_financial_report() from public, anon, authenticated;
revoke all on function public.finish_financial_report(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.fail_financial_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_financial_report(uuid, text) to service_role;
grant execute on function public.claim_financial_report() to service_role;
grant execute on function public.finish_financial_report(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.fail_financial_report(uuid, uuid) to service_role;

commit;
