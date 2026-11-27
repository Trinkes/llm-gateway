# Model-agnostic dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make request kind a first-class, unit-aware dimension across metrics APIs, Live, Power and the dashboard.

**Architecture:** `method` column = kind; new nullable `units` column; a kind registry (`request-kinds.ts`) attaches `unit`/`label` to every per-kind aggregate so the SPA renders from data. Power splits energy by per-kind busy seconds.

**Tech Stack:** Cloudflare Workers, D1, Durable Objects (SQLite), Hono, Vitest + `@cloudflare/vitest-pool-workers`, React + Vite dashboard.

**Spec:** `docs/superpowers/specs/2026-11-27-model-agnostic-dashboards-design.md`

## Global Constraints

- Mark new fork code `// [fork] W17`; add a W17 row to `FORK.md`.
- No deployment, client or host names in code, docs, commits or branch names.
- One class per file; no local (inline/dynamic) imports.
- No extra D1 round trips: new statements join existing `DB.batch` calls.
- Tests under `test/src/**` mirroring `src`; each view tested with `chat`, `image` and unknown kind `audio`.
- New/changed files at 100% coverage; `npm run build:dashboard` then `npx vitest run` passes.
- No Co-Authored-By lines in commits; PR on `Trinkes/llm-gateway` (`--repo Trinkes/llm-gateway`), not merged.

## Review Focus

- Rows written before migration 0009 (`units` NULL, old kinds) — must aggregate as 0 units, not NaN/null in totals.
- MetricsBuffer DO shards created before `units` existed — in-place ALTER, flush keeps `units`.
- Image request with invalid `n` (string, 0, 100) — stored units = 1.
- Kind with no registry entry — `unit: null`, label = kind string, dashboard shows requests + seconds.
- Power period with only image traffic — chat per-1M-token figure null, not divide-by-zero.

---

### Task 1: Kind registry, units column, recording

**Files:**
- Create: `src/metrics/request-kinds.ts`, `migrations/0009_request_units.sql`
- Modify: `src/metrics/collector.ts`, `src/durable/metrics-buffer.ts`, `src/metrics/request-logger.ts`, `src/requests/image_generations_v2.ts`, `src/requests/embeddings_v2.ts`, `src/app.ts` (pass ctx to embeddings)
- Test: `test/src/metrics/request-kinds.test.ts`, extend `request-logger.test.ts`, durable metrics-buffer test, image + embeddings route tests

**Interfaces:**
- Produces: `type KindUnit = "tokens" | "images" | null`; `kindInfo(kind: string): { kind: string; unit: KindUnit; label: string }`; `TOKEN_ROWS_SQL(alias?)` SQL predicate for "row has token counts"; `MetricDraft.units?: number | null`; `ChatAttempt.method: string`; outcome `units?: number | null`; `imageCount(n: unknown): number` (int 1..10 else 1).

- [ ] Test `kindInfo("chat").unit === "tokens"`, `kindInfo("embedding").unit === "tokens"`, `kindInfo("image")` → `{unit:"images", label:"Image"}`, `kindInfo("audio")` → `{unit:null,label:"audio"}`; `imageCount` cases `undefined→1, 4→4, 0→1, 11→1, "2"→1`.
- [ ] Test logger writes `units` and metrics buffer flush persists it; old shard without column gets ALTERed.
- [ ] Test image route row has `method:"image", units: n`; embeddings route writes `method:"embedding"`, `tokens_input = usage.prompt_tokens`.
- [ ] Implement; run `npx vitest run test/src/metrics test/src/durable test/src/requests`; commit.

### Task 2: Metrics APIs per kind

**Files:**
- Modify: `src/metrics/cost-tracker.ts`, `src/metrics/key-usage.ts`, `src/metrics/key-detail.ts`, `src/metrics/request-log.ts`, `src/api/metrics.ts`, `src/api/usage.ts`
- Create: `src/metrics/kind-usage.ts` (`KindUsage` type, `kindUsageStatement(env, whereSql, params)`, `toKindUsage(rows)`)
- Test: matching files in `test/src/metrics`, `test/src/api`

**Interfaces:**
- Produces: `KindUsage { kind, unit, label, requests, errors, units, tokensInput, tokensOutput, tokensCacheRead, costUsd, latencyAvgMs, busySeconds }`; `SpendSummary.byKind`; `SpendRangeOptions.kind`; `DailyCostRow.kinds: {kind, requests, units, costUsd}[]`; `KeyUsage.kinds: {kind, unit, label, requests, units}[]`; `KeyDetailUsage.summary.byKind`, `KeySeriesPoint.kinds: Record<string, number>`, `KeyModelUsage.kind`; `RequestFilters.kind`, `RequestLogRow.units`, `RequestFacet.kind`; latency rows carry `kind`.

- [ ] Tests seed chat + image + audio rows and assert: summary `byKind` per-kind latency/units; `kind` filter narrows summary and request list; cache usage excludes image/audio; keys per-kind counts; key detail series kinds; facets include kind; daily kinds; latency grouped by provider+kind.
- [ ] Implement with batches (summary + byKind in one batch; keys + kinds in one batch); run tests; commit.

### Task 3: Power and Live per kind

**Files:**
- Modify: `src/power/power-query.ts`, `src/power/power-summary.ts`, `src/api/power.ts` if shaping, `src/live/snapshot.ts`, `src/metrics/request-log.ts` (latest row carries units)
- Test: `test/src/power/*`, `test/src/live/snapshot.test.ts`

**Interfaces:**
- Produces: `PeriodRaw.kinds: KindBusy[]` where `KindBusy { kind, requests, units, busySeconds }`; `PowerTotals.kinds: KindEnergy[]` `{ kind, unit, label, requests, units, busySeconds, share, kwh, electricityUsd, perUnitUsd }` (perUnitUsd per 1M tokens for token kinds = per 1M output tokens, per image for images, per request for null unit); token sums and cloud/unpriced restricted to token rows; `electricityPer1mOutputUsd` uses token kinds' share.
- Snapshot `lastRequest` includes `units`; dashboard derives unit via facts in response: add `lastRequestUnit: KindUnit`.

- [ ] Tests: power period with chat + image + audio → shares sum to 1, chat per-1M uses only chat share; image-only period → token per-1M null; image rows not unpriced. Snapshot last image row exposes `units` and `lastRequestUnit:"images"`.
- [ ] Implement (KINDS_SQL statement added to the existing power batch); run tests; commit.

### Task 4: Dashboard

**Files:**
- Create: `dashboard/src/lib/requestKinds.ts` (`formatUsage(unit, {tokensInput, tokensOutput, units, latencyMs})`, `kindOptions(facets)`), `dashboard/src/components/KindUsageCard.tsx`
- Modify: `AnalyticsPage.tsx`, `RequestsPage.tsx`, `RequestDetailDrawer.tsx`, `DashboardPage.tsx`, `ApiKeyDetailPage.tsx`, `LivePage.tsx`, `PowerPage.tsx`, `lib/requestExplorer.ts`, `lib/powerTypes.ts`
- Test: `test/src/dashboard/request-kinds.test.ts`, extend `request-explorer.test.ts`

- [ ] Tests: `formatUsage("tokens", …)` → "1.2k / 300"; `("images",{units:4})` → "4 images"; `(null,{latencyMs:12300})` → "12.3 s"; kind filter round-trips in request explorer URL state.
- [ ] Implement pages; `npm run build:dashboard`; commit.

### Task 5: Docs, full run, PR

- [ ] FORK.md W17 row; `npx vitest run --coverage`; confirm total coverage ≥ main and new files 100%; push branch; `gh pr create --repo Trinkes/llm-gateway`.
