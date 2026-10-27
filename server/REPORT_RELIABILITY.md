# Company Report Reliability

## Deployment

The production report is now `compact-v5`: Business, Segments, History &
Footprint, Management & Strategy, Industry & Competition, Thesis, and Risks.
The writing target is 850-1100 Chinese characters, with about 250-350 for the
expanded Business chapter and short statements elsewhere. Business includes a
one-sentence positioning statement, an industry-specific four-stage process,
evidence-qualified profit capture, pricing/revenue recognition/channel mix,
and replication barriers with limitations. Four stages are a writing target,
not a brittle count check that rejects otherwise useful sourced output.
Revenue recognition comes from official accounting notes; channel percentages
and stage-level profitability must not be invented or inferred from revenue mix.
Before a new report is generated, the backend obtains its FMP snapshot using the
existing bounded/cached feed. The same snapshot is included in the Gemini prompt,
stored with the report, and returned for charts. Cached interpretations must not
be paired with newly fetched numbers. Legacy reports without a snapshot still
load charts separately, without synthesized interpretation text.
Segments retains FMP-only chart numbers. `segmentInsights.product` and
`segmentInsights.geographic` each contain 2-3 sentences (70-110 Chinese characters)
from the existing report-generation call, not an additional AI request.
The backend drops any extra `products` field a JSON-only retry might return.
Missing FMP data masks the corresponding insight and hides the chart.
Previous FY data is included only for a consecutive fiscal year in the same
currency; growth/change are calculated only for identical segment names with
positive prior amounts. Classification comparability still requires caution.
The prompt forbids numerical chart recitation or mechanical opening phrases.
Revenue shares alone do not prove cash generation, valuation drivers, market
maturity, retail-channel concentration, or overseas market headroom. Such claims
need supporting disclosures or explicit conditional language. Region labels must
not be conflated (e.g. Americas is not necessarily US).
Output budget remains 8192 tokens.
This does not guarantee availability or eliminate provider 503 errors.

Company reports now enable `{ googleSearch: {} }` and `{ urlContext: {} }` in
the existing `generateContent` call, alongside the JSON schema. Gemini 3's
tool/structured-output combination is preview functionality; keep a compatible
Gemini 3 primary/fallback model. SDK 2.24.0 already exposes both tools.
There is no separate SerpApi call in `/api/analyze-stock`. News radar still uses
SerpApi, so do not remove `SERPAPI_KEY` just because company reports changed.
No new environment variables or SQL migrations are needed for this change.

The prompt asks Search to find primary sources and URL Context to read relevant
pages according to chapter-specific source priorities:

- Business: latest filed 10-K Item 1, with official IR Overview as fallback.
- Segments: FMP JSON for chart numbers and history, with grounded qualitative
  context reused from official sources for the two short interpretation paragraphs.
- History & Footprint: official About/History, then grounded public event history.
- Management & Strategy: latest available earnings-call transcript; official
  same-quarter results/deck as an explicitly named fallback. Verify current
  leaders separately using official leadership pages.
- Industry & Competition: grounded multi-source competitor/industry analysis.
- Thesis: a supplied public research URL if present; otherwise grounded,
  dated market arguments and counterarguments, checked against official facts.
- Risks: 10-K Item 1A and newer 10-Q risk updates. Reuse the annual report URL.

These are model instructions, not a deterministic per-chapter fetch pipeline.
No per-company URLs were supplied, so Search discovers them. The app does not
invent section anchors, bypass paywalls, or claim a blocked transcript was read.
For foreign issuers or Taiwan stocks, equivalent official filings replace 10-K.
Tool execution is model-driven: enabling URL Context is not proof that
every linked page was read. Only successful `urlContextMetadata` retrievals
get a read-page label. Search chunks and successful retrievals are deduplicated
into the source list. Missing source metadata is advisory, not a report failure.
Source lists are not a claim of sentence-level verification or full coverage.
If JSON, required fields and generation completion pass, the report is returned
even with zero source URLs. Missing metadata triggers neither a research recovery
call nor a fallback-model retry. API errors and invalid JSON/content retain the
existing bounded retries, schema compatibility fallback and validation.
`sourceValidation` is logged and persisted in the service-role-only report cache,
but removed from HTTP responses. Search/URL tools enabled, observed query counts,
URL attempts/successes and source counts are recorded; absent execution evidence
is marked `not_reported`, not treated as proof that no tool ran. The frontend
shows no missing-source label or empty citation card; real links and Google's
returned Search Suggestions are preserved when available. No URLs are invented.
The prompt requires supported, qualified legal-risk statements. When tool URLs
are absent, compact-report litigation/enforcement risk entries are conservatively
replaced with a conditional generic risk, dropping unsupported names, amounts,
dates or claims that an event has already been verified.
Google's returned Search Suggestions HTML is displayed in a script-disabled
sandboxed iframe; citation links accept only HTTPS URLs without credentials.
See the official Search, URL Context, and structured-output documentation:
https://ai.google.dev/gemini-api/docs/generate-content/google-search
https://ai.google.dev/gemini-api/docs/generate-content/url-context
https://ai.google.dev/gemini-api/docs/generate-content/structured-output
Search tool calls and retrieved content can incur additional provider charges.

Deploy the compatible frontend to **Vercel first**, then the backend to Render.
The new frontend accepts all five compact versions and legacy full reports. Deploy
it before a backend that returns compact-v5 fields. The prompt/schema digest gives
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
budget measured with a monotonic clock. Google Search and URL Context are inside
the model call and therefore inside this budget; authentication and cache I/O
remain outside it. The browser retains its separate 210-second deadline.

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
attempt, within the same global call and time limits. Both retrieval tools stay
enabled during this retry; the application does not silently fall back to an
ungrounded report. Local JSON validation is unchanged.

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
- `company_report_sources`: source count, actual search query count and successful
  URL retrieval count, without logging full source text.

## Peer Comparison

Chapter 5 peer comparisons use `stock-peers` plus a target `profile`, then
`key-metrics-ttm` and `ratios-ttm` for the target and at most four peers.
There are no hard-coded company groups, ticker aliases, industry whitelists or
supplier blacklists. Every query starts with its own FMP list. Candidate profiles
must match the symbol, have a company name, and not identify an inactive listing,
ETF or fund. Duplicate issuers are removed by returned CIK, ISIN and normalized
company names rather than a list of special-case ticker aliases.

If fewer than three peers survive, one optional Google Search Gemini call
discovers candidates for that input company (8 seconds, SDK attempts=1, no model
fallback). Search candidates require HTTPS tool evidence and a matching FMP
profile/name before metric requests. Missing evidence simply leaves the list
sparse; it never blocks or retries the main report. Business similarity still
requires judgment; profile identity checks do not certify perfect comparability.
Discovery sources/queries are merged into the report source list, with discovery
counts separately recorded. `peerPolicy` in the cache digest prevents reuse of
reports generated under the previous fixed-list policy.

Only missing operating margins trigger `income-statement-ttm`. If unavailable,
`income-statement?period=quarter&limit=8` is checked for four distinct consecutive
fiscal quarters, valid ordered dates and a common reporting currency. Operating
income and revenue are summed before division (not averaged quarterly margins).
Annual rows, gaps, missing amounts, non-positive revenue and mixed currencies
are rejected. Calculated margins retain method and period end in the snapshot
and show this provenance in the chart. No stock-price/EPS or currency-mismatched
P/E is synthesized. All fallback requests share the original 20-second deadline;
401/429 stops further calls for that feed request rather than amplifying failure.

The optional peer feed has a 20-second total deadline, 8-second HTTP deadlines,
two concurrent reports and two company workers per report (four metric requests).
Its process cache holds at most 128 symbols for 24 hours (five minutes for errors
or unavailable comparisons). The report stores the exact `peerData` snapshot in
the existing three-day Supabase payload. Charts and the 80-120-character,
single-paragraph `industry.peerInsight` use that snapshot; browsers do not fetch
fresh peer figures or receive the FMP key. No SQL migration is needed.

The interpretation shares the existing report-generation call and configured
primary/fallback models. Only sparse-list discovery adds an optional AI call,
within the peer feed's original total deadline; cache hits do not rediscover.
The 80-120-character length is a writing target, not a display gate. Commentary
outside that range is retained and its length logged. Line breaks and list
prefixes are normalized into a single paragraph without truncating the analysis.
Empty commentary or unavailable comparison data is still omitted. Frontend
rendering applies the same paragraph normalization; the chart footer contains
only the provider link and retrieval date. `peerInsightPolicy` in the report cache
digest prevents reuse of commentary erased by the former strict length gate.
Missing metrics stay null, non-positive P/E or known negative/zero EPS is not
plotted, and negative operating margins retain their sign. Optional feed failures
hide unavailable charts without blocking other chapters. Cached snapshots are
not live quotes; different fiscal periods/accounting policies remain a caveat.

If either chart lacks a valid target-plus-peer comparison, the existing Gemini
call also researches `industry.qualitative`: an overview, sourced competitor
product/customer differences and a watch point. This can render independently
of FMP availability (including missing keys, unsupported markets or busy feeds).
Unsubstantiated qualitative fields remain undisclosed and are hidden, never
fabricated just to keep a chapter visible. Missing tool metadata remains advisory,
not a retry/failure trigger. The source panel stays shared with the report; a
qualitative-only comparison is not labeled as FMP financial data. Older reports
without this optional qualitative shape remain readable.

## Persistent Cache

The backend uses the existing Supabase service-role client. Browser roles have
no table privileges, RLS is enabled, and there are no permissive client policies.
Only public company-report content/search context is stored, never user IDs,
sessions or authentication headers.

Cache keys include market, normalized symbol, and a digest of the prompt, local
schema, configured models and retrieval provider/version. Switching away from
SerpApi invalidates old cache keys without deleting the old rows. Structurally
complete reports, including those without source metadata, are saved for three days (72 hours);
incomplete output, failed calls and source-limited
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
