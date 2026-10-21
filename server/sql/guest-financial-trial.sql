begin;

-- A separate claim survives deletion of the report and prevents a second trial.
create table if not exists public.financial_guest_trials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  symbol text not null,
  created_at timestamptz not null default now()
);
alter table public.financial_guest_trials enable row level security;
revoke all on public.financial_guest_trials from public, anon, authenticated;

create or replace function public.enforce_guest_financial_trial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_user uuid;
begin
  -- Scheduled workers must still update anonymous users' reports.
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    if tg_op <> 'INSERT' then
      raise exception '訪客報告為唯讀；新增更多股票請登入免費會員。' using errcode = '42501';
    end if;
    if new.user_id is distinct from auth.uid() then
      raise exception '無法使用其他人的訪客身分。' using errcode = '42501';
    end if;
    if new.status is distinct from 'pending' or new.summary is not null
       or new.report_json is not null or new.report_url is not null then
      raise exception '訪客只能新增待處理的股票。' using errcode = '42501';
    end if;
    if new.symbol is null or new.symbol !~ '^[A-Z0-9][A-Z0-9.^-]{0,19}$' then
      raise exception '股票代碼格式不正確。' using errcode = '22023';
    end if;
    insert into public.financial_guest_trials (user_id, symbol)
      values (auth.uid(), new.symbol)
      on conflict (user_id) do nothing returning user_id into claimed_user;
    if claimed_user is null then
      raise exception '訪客僅能試用 1 檔股票，請登入免費會員以追蹤更多。' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_guest_financial_trial() from public, anon, authenticated;
drop trigger if exists enforce_guest_financial_trial on public.tracked_stocks;
create trigger enforce_guest_financial_trial
  before insert or update or delete on public.tracked_stocks
  for each row execute function public.enforce_guest_financial_trial();

alter table public.tracked_stocks enable row level security;
-- Restrictive ownership also applies when older permissive policies exist.
drop policy if exists financial_report_owner_guard on public.tracked_stocks;
create policy financial_report_owner_guard on public.tracked_stocks
  as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists financial_report_owner_access on public.tracked_stocks;
create policy financial_report_owner_access on public.tracked_stocks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The anon role is the public API key, not a signed-in anonymous user.
revoke all on public.tracked_stocks from anon;
grant select, insert, update, delete on public.tracked_stocks to authenticated;

-- The client checks this before creating an anonymous session.
create or replace function public.guest_financial_trial_ready()
returns boolean language sql immutable set search_path = ''
as $$ select true $$;
revoke all on function public.guest_financial_trial_ready() from public;
grant execute on function public.guest_financial_trial_ready() to anon, authenticated;

commit;
