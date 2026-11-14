# Fixed Visitor Reports

Visitors read frozen AAPL company and financial reports. Viewing a demo never
calls Gemini or FMP and never creates an anonymous Supabase session or report job.
Members keep their existing reports, quotas, tracking lists and three-day cache.

## Release Order

1. In Supabase SQL Editor, run `sql/fixed-demo-reports.sql` as the administrator.
   It copies only the completed AAPL reports owned by `kimmer922@gmail.com`.
   Both snapshots and the anonymous-access restrictions commit together.
   A missing or incomplete source report rolls back the transaction.
2. Deploy the backend on Render.
3. Deploy the separate HIMS_chart project on Vercel, then deploy this project's frontend.
4. In a private browser window, open both report pages. Each must show AAPL,
   a demo label and a login link. Charts and summary tabs must remain usable.

The SQL also blocks direct anonymous access to `tracked_stocks` (including
Supabase anonymous users that have the `authenticated` database role), closes the
old trial readiness RPC and stops already queued/running anonymous jobs. It does
not delete member data. Backend generation routes reject anonymous users.
Disabling Anonymous Sign-Ins in Supabase Auth is an optional additional measure
after checking that no other feature requires them; it does not replace RLS.

## Verify

In SQL Editor:

```sql
select kind, symbol, published_at from public.demo_reports order by kind;
```

There must be two AAPL rows. Public endpoints `/api/demo-reports/company` and
`/api/demo-reports/financial` expose only their published snapshot, not an owner's
ID, email, tracking ID or session. Other report kinds return 404. Missing snapshots
return 503; they never fall back to generation or another member's report.

Check that `/api/analyze-stock`, `/api/financial-reports` and
`/api/chat-with-report` return 401 without a member session. With an anonymous
Supabase session, direct writes to `tracked_stocks` must fail too. With a normal
member session, saved reports and generation must still work.

## Snapshot Lifetime

Demo payloads do not expire after three days and do not follow edits/deletions of
the original member report. Re-running the migration does not replace an already
published snapshot. To publish a new version:

1. Generate and review the two replacement AAPL reports in the same member account.
   Viewing a saved report is not regeneration; check its source/generation dates.
2. Run `sql/publish-demo-reports.sql` in Supabase SQL Editor as administrator.
   This replaces both snapshots together, or preserves both old versions on error.
   It does not invoke AI, change member reports or rerun the access migration.
3. Confirm the two returned `published_at` values, then check both pages logged out.

Content-only publishing does not require a new deployment. The backend and browser
each cache demo responses for up to five minutes; allow up to ten minutes for both
layers to refresh. Source dates remain visible so visitors do not mistake them
for live data. A layout/code change still requires the relevant app deployment.
