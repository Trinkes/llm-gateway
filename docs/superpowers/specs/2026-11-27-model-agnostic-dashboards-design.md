# Model-agnostic dashboards (fork W17)

## Intent

The request log (`request_metrics`) now holds more than chat: image
generations write rows with `method = "image"`, no tokens and cost 0. The
dashboards were built for token-based chat, so image rows show "0 / 0
tokens", inflate latency averages, and the Power page charges image GPU time
to chat tokens. Goal: any request kind and any provider/model is counted and
shown in units that fit it, and a new kind or provider appears with no
dashboard code change.

## Goals

- Request kind is a first-class dimension: per-kind totals in the summary,
  per kind per key and per day, a kind filter and column in the request log.
- Each kind is measured in its own unit: tokens for chat and embeddings,
  images (plus seconds) for image generation. An unknown kind still shows
  requests, errors, cost and seconds.
- Averages are taken per kind, so a token-less row never drags a token or
  latency figure.
- Provider and model lists come from data (already true; keep it).
- Power page splits box energy across kinds by busy time.
- Live "last request" and throughput handle any kind.

## Non-goals

- No new pricing model for images (they stay cost 0; cloud comparison stays
  token-only).
- No change to ProvidersPage's provider catalog (provider setup, not metrics).
- No rename of the `method` column.

## Anti-goals

- A new kind needing a dashboard code change to appear.
- Extra D1 round trips: new queries join existing `DB.batch` calls.
- Deployment, client or host names anywhere in code, docs or commits.

## Approaches considered (Power attribution)

- **A. Share by busy time (picked by the user).** Per period, sum each kind's
  request-seconds (`latency_ms`) for successful, non-cached box requests.
  Measured energy is split by each kind's share. Chat gets electricity per
  1M output tokens from its share; images get electricity per image.
  Cheap SQL in the existing batch. Overlapping requests over-count busy time,
  so the split is approximate.
- B. Exclude image rows: smallest change, but image GPU time stays in the
  per-token figure.
- C. Energy per request window from host samples: more exact, heavy query over
  raw 10 s rows, messy when kinds overlap.

## Design

### Kind and units (backend)

- `method` stays the kind column. Values: `chat`, `image`, `embedding`, and
  whatever a future route writes. `ChatAttempt.method` widens to `string`.
- New nullable column `units INTEGER` (migration `0009_request_units.sql`,
  plus in-place `ALTER` in the MetricsBuffer DO table and the flush/insert
  paths). It holds the count of the kind's own unit when that unit is not
  tokens: image rows store the requested image count (`n`, default 1, integer
  1..10 else 1).
- New module `src/metrics/request-kinds.ts`: a small registry
  `kind -> { unit: "tokens" | "images" | null, label }` with
  `chat`/`embedding` = tokens, `image` = images, unknown = `null` unit and the
  kind string as label. APIs attach `unit` and `label` per kind, so the
  dashboard renders from the response, never from a hardcoded kind list.
- New shared type `KindUsage`: `{ kind, unit, label, requests, errors,
  units, tokensInput, tokensOutput, tokensCacheRead, costUsd, latencyAvgMs,
  busySeconds }`.

### Embeddings (my call)

`embeddings_v2.ts` records no row today. It will record one row per request
with kind `embedding`, `usage.prompt_tokens` as input tokens, and cost
estimated from `model_pricing` like chat. Side effect: embedding spend now
counts toward spend caps after the fact (no pre-check is added).

### APIs

All new reads go into existing batches or replace a single query with a
two-statement batch.

- `GET /api/metrics/summary`: adds `byKind: KindUsage[]`; accepts `kind`
  filter. Top-level `avgLatencyMs` stays (all rows); per-kind latency is in
  `byKind`.
- `GET /api/usage/costs`: each day gains `kinds: {kind, requests, units,
  costUsd}[]` (one grouped query by day + kind, folded in JS).
- `GET /api/metrics/latency`: grouped by provider + kind (rows carry `kind`).
- `GET /api/metrics/cache`: only rows with any token count (data-driven, no
  kind list), so image models no longer appear with 0% hit rate.
- `GET /api/metrics/keys`: each key gains `kinds: {kind, unit, label,
  requests, units}[]` (second statement in a batch, grouped by key + kind).
  `latencyAvgMs` stays all-rows.
- `GET /api/metrics/keys/:id`: summary gains `byKind`; series points gain
  `kinds` (requests per kind per bucket); models gain `kind`.
- `GET /api/metrics/requests`: `kind` filter; rows carry `units`. Facets
  return `{provider, model, kind, requests}`.
- `GET /api/live`: `lastRequest` carries `units`, `kind`, `unit`. Throughput
  stays tok/s (token rows only contribute; non-token kinds are a no-op).
- `GET /api/power`: totals and periods gain `kinds: {kind, unit, label,
  requests, units, busySeconds, share, kwh, electricityUsd, perUnitUsd}`;
  `electricityPer1mOutputUsd` uses only token kinds' energy share. Token sums
  and cloud comparison count token rows only, so image rows no longer show as
  "unpriced".

### Dashboard

- Shared helper `dashboard/src/lib/requestKinds.ts` (tested): formats a
  row's or kind's usage from its `unit` ("1.2k in / 300 out", "4 images",
  "12.3 s"), so pages call one function.
- Analytics: "By kind" card (requests, errors, usage in unit, avg latency,
  cost); kind filter applied to summary; request table gains Kind column and
  unit-aware usage; latency table gains Kind.
- Requests page: kind dropdown (from facets), Kind column, unit-aware usage
  column; drawer shows token breakdown only for token kinds, else units +
  seconds.
- Dashboard page: daily chart stays requests/cost; tooltip/legend unchanged;
  summary stat "Total tokens" kept plus a per-kind requests line.
- API key detail: per-kind summary chips, Kind column in models and recent
  requests.
- Live "Last inference" becomes "Last request": token kinds keep
  decode/TTFT/tokens; other kinds show kind, duration and units.
- Power: per-kind energy table (kind, requests, usage, busy share, kWh,
  electricity, per-unit cost); "per 1M output tokens" labelled as chat
  share.

## Testing

Each changed view gets tests with chat rows, image rows and an unknown kind
(`"audio"`), under `test/src/**`. New and changed files at 100% coverage.

## Left to the builder

Exact SQL shapes, card layout details, naming of helper functions.
