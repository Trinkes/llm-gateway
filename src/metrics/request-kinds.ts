// [fork] W17: registry of request kinds (`request_metrics.method`). The
// dashboards render from the unit and label attached here, never from a
// hardcoded kind list, so a new route only needs a row in this table.
export type KindUnit = "tokens" | "images" | null;

export interface KindInfo {
  kind: string;
  unit: KindUnit;
  label: string;
}

const KINDS = new Map<string, { unit: KindUnit; label: string }>([
  ["chat", { unit: "tokens", label: "Chat" }],
  ["embedding", { unit: "tokens", label: "Embedding" }],
  ["image", { unit: "images", label: "Image" }],
  // [fork] W20: passthrough routes (vpc_passthrough_v2.ts), measured in time.
  ["transcription", { unit: null, label: "Transcription" }],
  ["speech", { unit: null, label: "Speech" }],
  ["decision", { unit: null, label: "Decision" }],
]);

/** Unit and label of a kind; an unknown kind has no unit and labels itself. */
export function kindInfo(kind: string): KindInfo {
  const known = KINDS.get(kind);
  return {
    kind,
    unit: known ? known.unit : null,
    label: known ? known.label : kind,
  };
}

/** Requested image count: an integer 1..10, else 1. */
export function imageCount(n: unknown): number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 10
    ? n
    : 1;
}

/**
 * SQL predicate: the row carries any token count. Lets token-only reads
 * (cache hit rate, throughput) skip other kinds without listing them.
 */
export function TOKEN_ROWS_SQL(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `(${[
    "tokens_input",
    "tokens_output",
    "tokens_cache_read",
    "tokens_cache_write",
  ]
    .map((c) => `COALESCE(${p}${c}, 0) > 0`)
    .join(" OR ")})`;
}
