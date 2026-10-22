# Company Report Reliability

## Deployment

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

## SDK Audit

The application pins `@google/genai` to **2.24.0** in both package manifests.
The audit and tests use the published 2.24.0 npm package, not the current main
branch or a different SDK. `gemini-runtime.test.js` injects mock HTTP responses
into the real SDK and makes no paid API requests:

- No `retryOptions`: one HTTP attempt.
- `retryOptions` exists but `attempts` is omitted: five attempts by default.
- Explicit `retryOptions: { attempts: 1 }`: one HTTP attempt. This is configured
  both on the client and per call, so application retries cannot multiply with
  SDK retries.
- `httpOptions.timeout` is a **per-HTTP-attempt** timer in milliseconds, including
  reading the response body. This SDK also sends `X-Server-Timeout` as timeout
  rounded up to seconds. A Google `504 DEADLINE_EXCEEDED` can therefore reflect
  this requested server deadline; it is not proof of a Render proxy timeout.
- The report's separate `AbortSignal.timeout` bounds the SDK call as a whole.

Run tests after dependency installation with `cd server` followed by `npm test`.
Mock tests verify control flow and error handling, not live Gemini reliability.

## Small Live Probes

Run `npm run diagnose:gemini` from `server/` in an environment that already has
the backend's `GEMINI_API_KEY` (for example, Render Shell if available). It uses
the configured primary and fallback models and makes one plain-text OK request
and one small JSON request for each: at most four sequential requests, no SDK or
application retries, and a 65-second timeout per request. These calls still use
Gemini API quota/billing; they do not consume site report quota, call SerpApi,
access Supabase or populate report caches. No diagnostic HTTP endpoint is added.

Share the `gemini_diagnostic` lines, not keys or environment variable dumps.
If both small probes return 503, the full report's length/JSON validation is not
required to reproduce the failure. If only the JSON probe fails, investigate
structured-output handling. If both pass while full reports fail, investigate
report complexity, timeout and output validation; one successful probe does not
establish overall reliability or prove a Free/Paid tier is the cause.

### Full Report Schema Comparison

After deploying the diagnostic command, run `npm run diagnose:report -- AAPL`
from the backend directory. It needs the existing `GEMINI_API_KEY` and
`SERPAPI_KEY`; never pass them as command arguments or paste them into chat.
It uses the configured primary model only. Three bounded SerpApi searches build
one shared source snapshot; that exact snapshot and the unchanged production
report prompt are reused in two sequential Gemini calls. Only the provider-side
`responseJsonSchema` differs. Both calls retain JSON MIME type, local completeness
validation, 32768 output tokens, low thinking for Gemini 3, and a 65-second
timeout. No retry, fallback, Supabase writes or site quota charges are involved.
These calls still consume provider quota and can incur normal API charges.

Share the two `gemini_report_diagnostic` results. A 200 response with invalid JSON
is distinct from a 503 rejection. One pair cannot prove causation: provider load
can change between the two calls. This diagnostic deliberately does not replace
or automatically change the site's production generation behavior.

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
