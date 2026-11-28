// [fork] W22: per-model activity on the Live page, rebuilt from the request log.
// A "model" is one (provider, kind) pair. Busy time is the average number of
// that pair's requests running in a bucket; a request covers
// `[timestamp - latency, timestamp)`, so a running job shows once it finishes.
import { kindInfo, type KindUnit } from "../metrics/request-kinds";

/** The request-row fields per-model activity is built from. */
export interface ModelRequest {
  /** Unix seconds when the request finished. */
  timestamp: number;
  latency_ms: number;
  provider: string;
  method: string;
  status_code: number;
  units: number | null;
  tokens_input: number;
  tokens_output: number;
}

export interface BusyPoint {
  ts: number;
  /** Average requests running during the bucket. */
  busy: number;
  /** Peak 10 s value inside the bucket; null when the bucket is a single 10 s slot. */
  busyMax: number | null;
}

export interface ModelActivity {
  provider: string;
  /** Request kind (`request_metrics.method`); null for a provider with no rows. */
  kind: string | null;
  unit: KindUnit;
  label: string;
  busy: BusyPoint[];
  /** Requests that finished in the window (errors included). */
  requests: number;
  errors: number;
  /** Mean latency of the successful requests; null without any. */
  latencyAvgMs: number | null;
  tokensInput: number;
  tokensOutput: number;
  units: number;
}

/** A model before labelling: what `finishModels` completes. */
export type ModelGroup = Omit<ModelActivity, "unit" | "label">;

/**
 * Average concurrency per `bucketS` bucket of `[from, to)`: the overlap
 * seconds of every request with the bucket, divided by the bucket width.
 */
export function spreadBusy(
  rows: ModelRequest[],
  from: number,
  to: number,
  bucketS: number,
): number[] {
  const sums = new Array<number>(Math.ceil((to - from) / bucketS)).fill(0);
  for (const r of rows) {
    const start = r.timestamp - r.latency_ms / 1000;
    const end = r.timestamp;
    if (end <= start) continue;
    const first = Math.max(0, Math.floor((start - from) / bucketS));
    const last = Math.min(sums.length - 1, Math.floor((end - from) / bucketS));
    for (let i = first; i <= last; i++) {
      const lo = Math.max(start, from + i * bucketS);
      const hi = Math.min(end, from + (i + 1) * bucketS);
      if (hi > lo) sums[i] += hi - lo;
    }
  }
  return sums.map((s) => s / bucketS);
}

/** `provider|method`, the key a model is grouped by. */
export function modelKey(provider: string, method: string): string {
  return `${provider}|${method}`;
}

/**
 * Label each group, add an idle entry (busy `idleBusy`) for every name in
 * `providers` without a group, and order by requests, then label.
 */
export function finishModels(
  groups: ModelGroup[],
  providers: string[],
  idleBusy: BusyPoint[],
): ModelActivity[] {
  const labelled: ModelActivity[] = groups.map((g) => {
    const info = g.kind === null ? null : kindInfo(g.kind);
    return {
      ...g,
      unit: info ? info.unit : null,
      label: info ? `${g.provider} · ${info.label}` : g.provider,
    };
  });
  const seen = new Set(groups.map((g) => g.provider));
  const idle: ModelActivity[] = [...new Set(providers)]
    .filter((p) => !seen.has(p))
    .map((provider) => ({
      provider,
      kind: null,
      unit: null,
      label: provider,
      busy: idleBusy.map((p) => ({ ...p })),
      requests: 0,
      errors: 0,
      latencyAvgMs: null,
      tokensInput: 0,
      tokensOutput: 0,
      units: 0,
    }));
  return [...labelled, ...idle].sort(
    (a, b) => b.requests - a.requests || a.label.localeCompare(b.label),
  );
}

/** Per-model busy series (`bucketS` buckets) and stats for `[from, to)`. */
export function modelActivity(
  rows: ModelRequest[],
  providers: string[],
  from: number,
  to: number,
  bucketS: number,
): ModelActivity[] {
  const byKey = new Map<string, ModelRequest[]>();
  for (const r of rows) {
    const key = modelKey(r.provider, r.method);
    const group = byKey.get(key);
    if (group) group.push(r);
    else byKey.set(key, [r]);
  }
  const toPoints = (busy: number[]): BusyPoint[] =>
    busy.map((b, i) => ({ ts: from + i * bucketS, busy: b, busyMax: null }));
  const groups: ModelGroup[] = [...byKey.values()].map((group) => {
    const finished = group.filter(
      (r) => r.timestamp >= from && r.timestamp < to,
    );
    const ok = finished.filter((r) => r.status_code < 400);
    return {
      provider: group[0].provider,
      kind: group[0].method,
      busy: toPoints(spreadBusy(group, from, to, bucketS)),
      requests: finished.length,
      errors: finished.length - ok.length,
      latencyAvgMs:
        ok.length > 0
          ? ok.reduce((s, r) => s + r.latency_ms, 0) / ok.length
          : null,
      tokensInput: ok.reduce((s, r) => s + r.tokens_input, 0),
      tokensOutput: ok.reduce((s, r) => s + r.tokens_output, 0),
      units: ok.reduce((s, r) => s + (r.units ?? 0), 0),
    };
  });
  const idleBusy = toPoints(
    new Array<number>(Math.ceil((to - from) / bucketS)).fill(0),
  );
  return finishModels(groups, providers, idleBusy);
}
