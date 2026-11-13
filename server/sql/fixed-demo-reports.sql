begin;

-- Only the backend can read these public-content-only snapshots. No member IDs
-- or sessions are copied. Member deletions and the three-day cache do not affect them.
create table if not exists public.demo_reports (
  kind text primary key check (kind in ('company', 'financial')),
  symbol text not null check (symbol = 'AAPL'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  published_at timestamptz not null default now()
);
alter table public.demo_reports enable row level security;
revoke all on public.demo_reports from public, anon, authenticated;
grant select on public.demo_reports to service_role;

-- Freeze only this owner's ready AAPL reports, or roll back the whole migration.
do $$
declare
  owner_id uuid;
  company jsonb;
  financial jsonb;
  financial_summary text;
begin
  select id into owner_id from auth.users
    where lower(email) = 'kimmer922@gmail.com' and not coalesce(is_anonymous, false);
  if owner_id is null then raise exception 'DEMO_OWNER_NOT_FOUND'; end if;
  select payload into company from public.company_saved_reports
    where user_id = owner_id and symbol = 'AAPL';
  select report_json, summary into financial, financial_summary from public.tracked_stocks
    where user_id = owner_id and symbol = 'AAPL' and status = 'ready'
    order by created_at desc limit 1;
  if jsonb_typeof(company -> 'report') is distinct from 'object'
      or jsonb_typeof(company -> 'revenueData') is distinct from 'object' then
    raise exception 'DEMO_COMPANY_AAPL_NOT_READY';
  end if;
  if financial ->> 'symbol' is distinct from 'AAPL'
      or jsonb_typeof(financial -> 'data') is distinct from 'object'
      or jsonb_typeof(financial -> 'ai') is distinct from 'object'
      or nullif(btrim(financial_summary), '') is null then
    raise exception 'DEMO_FINANCIAL_AAPL_NOT_READY';
  end if;
  select jsonb_object_agg(key, value) into company from jsonb_each(company)
    where key in ('report', 'reportFormat', 'revenueData', 'peerData', 'valuationData',
      'generatedAt', 'sourceInfo', 'grounding', 'searchContext', 'reportMode');
  select jsonb_object_agg(key, value) into financial from jsonb_each(financial)
    where key in ('symbol', 'data', 'ai', 'as_of', 'ai_generated_at', 'currency', 'periods',
      'filing', 'officialDocument', 'sources', 'generation_provider', 'searchEntryPointHtml');
  insert into public.demo_reports(kind, symbol, payload) values
    ('company', 'AAPL', company),
    ('financial', 'AAPL', jsonb_build_object('symbol', 'AAPL', 'report_json', financial, 'summary', financial_summary))
    on conflict (kind) do nothing;
end;
$$;

-- Anonymous Supabase sessions use the authenticated role too. A restrictive
-- policy blocks direct writes even if an older permissive policy remains.
alter table public.tracked_stocks enable row level security;
revoke all on public.tracked_stocks from public, anon;
drop policy if exists financial_members_only on public.tracked_stocks;
create policy financial_members_only on public.tracked_stocks
  as restrictive for all to authenticated
  using (auth.uid() is not null and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
  with check (auth.uid() is not null and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false));

create or replace function public.guest_financial_trial_ready()
returns boolean language sql immutable set search_path = '' as $$ select false $$;

-- Stop previously queued anonymous jobs without deleting their reports.
update public.financial_report_jobs j set state = 'failed', lease_token = null,
  lease_until = null, updated_at = now()
  from auth.users u where j.user_id = u.id and u.is_anonymous = true
    and j.state in ('queued', 'running');
update public.tracked_stocks s set status = 'financial_error'
  from auth.users u where s.user_id = u.id and u.is_anonymous = true
    and s.status in ('pending', 'financial_queued', 'financial_running');

commit;
