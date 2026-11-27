// [fork] W21: transcriptions are priced from the `usage` tokens of the
// upstream's JSON reply (OpenAI's `{"type":"tokens", input_tokens,
// output_tokens}`). The counts only feed pricing and the rate limit; they are
// not stored in the token columns, so transcription rows stay out of token
// stats (request-kinds.ts TOKEN_ROWS_SQL).
import type { TokenUsage } from "./cost-tracker";

const decoder = new TextDecoder();

/**
 * Input (audio) and output (text) tokens of a transcription reply, or null
 * when the reply is not JSON, has no `usage`, its `usage.type` is not
 * `tokens`, or its counts are not non-negative numbers (such a reply costs 0).
 * Cached input tokens are still audio and are priced as input.
 */
export function transcriptionUsage(reply: Uint8Array): TokenUsage | null {
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(reply));
  } catch {
    return null;
  }
  if (!isObject(json) || !isObject(json.usage)) return null;
  // OpenAI's `duration` usage (whisper-1) bills seconds, not tokens.
  const type = json.usage.type;
  if (type !== undefined && type !== "tokens") return null;
  const input = count(json.usage.input_tokens);
  const output = count(json.usage.output_tokens);
  if (input === null || output === null) return null;
  if (input === 0 && output === 0) return null;
  return { input, output, cacheRead: 0, cacheWrite: 0 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A missing count is 0; a present one must be a finite number >= 0. */
function count(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
