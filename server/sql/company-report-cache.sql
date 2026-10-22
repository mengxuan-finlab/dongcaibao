begin;

create table if not exists public.company_report_cache (
  cache_key text primary key,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists company_report_cache_expiry_idx
  on public.company_report_cache (expires_at);

-- Reports are shared through the backend, never directly writable by browsers.
alter table public.company_report_cache enable row level security;
revoke all on public.company_report_cache from public, anon, authenticated;
grant select, insert, update, delete on public.company_report_cache to service_role;

comment on table public.company_report_cache is
  'Validated company reports only; three-day TTL is enforced by the application.';

commit;
