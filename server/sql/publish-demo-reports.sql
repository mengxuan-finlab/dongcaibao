-- Run in Supabase SQL Editor as administrator AFTER reviewing both new AAPL reports.
-- Copies the current saved reports; does not call AI or refresh their source data.
-- Both demos are replaced atomically. Validation failure keeps the old version.
begin;

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
    on conflict (kind) do update set
      symbol = excluded.symbol,
      payload = excluded.payload,
      published_at = now();
end;
$$;

commit;

select kind, symbol, published_at from public.demo_reports order by kind;
