# Company Report Reliability

## Deployment

The production report is now `compact-v1`: company/revenue/customers, main
products, growth and risks, and financial/operating watch items. The prompt no
longer requests a timeline, value-chain diagram, governance, competitor tables,
news tags or the full research dashboard. Output budget is 8192 tokens (formerly
32768). This reduces generation work; it does not guarantee availability or
eliminate provider 503 errors.

Deploy the compatible frontend to **Vercel first**, then the backend to Render.
The new frontend accepts compact and legacy full reports. Existing old frontends
cannot render compact responses. The prompt/schema digest automatically gives
compact reports a different cache key; old full cache rows need not be deleted.

1. In the existing Supabase project's SQL Editor, run
   `server/sql/company-report-cache.sql`. It creates a new cache table only;
   existing member reports and financial tracking tables are not modified.
2. Deploy the backend with `npm ci` and `npm start` from `server/`.
   No new environment variables or browser credentials are required.
3. Check the `[Gemini SDK]` startup log for the installed version (`2.24.0`),
   `sdkAttempts: 1`, and `retryOwner: application`. The startup log, not the
   lockfile alone, confirms the SDK actually loaded in Render.
4. Generate one complete report, then restart the backend and request the same
   symbol. `[公司報告結果]` should report `cacheTier: database`, with no new
   Gemini call. This is an operational check, not a claim that the live database
   has already been migrated or tested.

If the table is missing, inaccessible, or timed out, generation still works with
the memory cache. `[報告資料庫快取]` logs the problem and suppresses database
attempts for one minute before trying again. Each read/write has a two-second
abort signal. After applying SQL, retry after the cooldown or restart the service.

## Retry Budget and Diagnostics

Company reports have a 65-second per-call ceiling and a 130-second total AI
budget measured with a monotonic clock. Search, authentication and cache I/O are
outside that AI budget. The browser retains its separate 210-second deadline.

The application allows at most four SDK calls overall. Retryable API failures
(including 503/504) retry the same model at most twice, with approximately
one- and two-second exponential backoff plus jitter (eight-second computed cap).
A longer `Retry-After` is respected only if it fits the remaining budget;
otherwise that retry is skipped. Up to 40 seconds and one call slot are reserved
for the existing Gemini fallback. No background queue or cross-provider fallback
is introduced in this phase.

JSON parsing, incomplete generation and local schema validation failures are
separate from API failures. They do not trigger API backoff. One alternative
output attempt is allowed; partial reports are never returned as successful.
A provider schema rejection (HTTP 400) still gets one JSON-only compatibility
attempt, within the same global call and time limits.

- `gemini_http`: actual HTTP status and time until response headers.
- `gemini_call`: complete SDK call duration, including response decoding or the
  consumed stream. Stream errors and cancellation are also recorded.
- `company_report_attempt`: report generation and validation outcome, attempt,
  timeout, elapsed time, and an explicit error source (`gemini_api`,
  `client_timeout`, `network`, `sdk`, `json_parse`, `generation_finish`, or
  `report_validation`). Output validation failures keep HTTP status **200**;
  no-response errors use **null**, never `NaN` or a fabricated status code.
- The request ID, model, attempt and label correlate these events. API keys,
  authorization headers, full prompts and generated reports are not logged.

## Persistent Cache

The backend uses the existing Supabase service-role client. Browser roles have
no table privileges, RLS is enabled, and there are no permissive client policies.
Only public company-report content/search context is stored, never user IDs,
sessions or authentication headers.

Cache keys include market, normalized symbol, and a digest of the prompt, local
schema and configured models. Complete reports with sufficient search coverage
are saved for three days (72 hours); incomplete output, failed calls and source-limited
reports are never saved. Database hits are revalidated against the current
schema, and loading an existing row does not extend its expiry. DB failures do
not turn a successfully generated report into an API failure.

The TTL is set by the application, not a database timer. Existing rows keep their
original expiry; newly generated reports use the three-day TTL after deployment.
Changing the TTL does not require rerunning the table migration.

Concurrent requests for the same key are coalesced within one Node process.
This is not a cross-instance lock: simultaneous cold misses in separate
instances can still generate twice. Expired database rows are ignored; a future
maintenance task can remove them with:

```sql
delete from public.company_report_cache where expires_at < now();
```

The next phase (only after live metrics are collected) is a background job queue
and, if needed, a different provider fallback. This cache does not solve failures
of the first generation or provide a service-availability guarantee.
