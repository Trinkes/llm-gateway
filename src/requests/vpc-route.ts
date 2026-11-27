// [fork] W20: the shared flow of the non-chat routes served only by vpc
// providers (image generations, image edits, transcriptions, speech,
// systemone): tenant and spend checks, provider resolution and policy, the vpc
// fetcher, the rate limit, one request row per request, and the heartbeat for
// slow upstreams. Moved out of image_generations_v2.ts (W15, W19) unchanged.
import { TenantService } from "../db/tenant";
import { getProviderConfig } from "../llm/credential-store";
import { upstreamModelId } from "../llm/model-aliases";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
  keyMayUseProvider,
  type PolicyError,
} from "../llm/policy";
import {
  canonicalProviderName,
  isOpenAICompatibleProvider,
} from "../llm/provider-registry";
import { checkRateLimits, settleTokenUsage } from "../llm/rate-limit";
import { resolveFetcher, type UpstreamFetcher } from "../llm/transport";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import {
  computeCostUsd,
  getModelPricing,
  type TokenUsage,
} from "../metrics/cost-tracker";
import { recordChatRequest, type ChatAttempt } from "../metrics/request-logger";
import { maybeDisableAfterSpend } from "../metrics/spend-guard";
import { ApiKeyAuth } from "../types";

/** Wait this long for upstream headers before committing a 200 heartbeat. */
export const IMAGE_GRACE_MS = 15_000;
/** Interval between heartbeat spaces once the 200 is committed. */
export const IMAGE_HEARTBEAT_MS = 10_000;
/** Give up on an upstream that has not answered after this long (hung GPU). */
export const IMAGE_MAX_MS = 600_000;

const ERROR_TEXT_LIMIT = 512;

export interface VpcRouteInput {
  request: Request;
  env: Env;
  apiKeyAuth: ApiKeyAuth;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  /** Tests only; defaults to IMAGE_GRACE_MS / IMAGE_HEARTBEAT_MS. */
  timing?: { graceMs: number; heartbeatMs: number; maxMs?: number };
}

/** What a route read from the client's request. */
export interface RouteRequest {
  /** `provider/model`, or a bare model for a key with a default provider. */
  rawModel: string;
  /** The upstream body, given the model id the upstream knows. */
  body(upstreamModel: string): BodyInit;
  /** Upstream content type; null lets fetch set it (multipart). */
  contentType: string | null;
  /** Output tokens to rate-limit and (when `priced`, without `replyUsage`) price the request at. */
  tokens: number;
  /** Count of the kind's unit for a successful request (request-kinds.ts). */
  units: number | null;
  /** Overrides the spec's `heartbeat` for this request (e.g. a text reply). */
  heartbeat?: boolean;
}

export interface VpcRouteSpec {
  /** `request_metrics.method` of the rows this route writes. */
  kind: string;
  /** Plural noun for error messages, e.g. "image generations". */
  what: string;
  /** Read and validate the client's request; a Response is a 4xx to return. */
  parse(request: Request): Promise<RouteRequest | Response>;
  /** Refuse a provider whose settings do not enable this route. */
  enabled?(settings: Record<string, unknown>): boolean;
  /** Send the upstream request. */
  send(
    client: V1OpenAICompatibleClient,
    body: BodyInit,
    init: { signal: AbortSignal; contentType: string | null },
  ): Promise<Response>;
  /** Commit a 200 and send heartbeat spaces when the upstream is slow (JSON replies only). */
  heartbeat: boolean;
  /** Price `tokens` as output tokens; otherwise the row costs 0. */
  priced: boolean;
  /**
   * [fork] W21: price a successful request from its reply instead of
   * `tokens`. The reply is buffered on its way to the client and reaches it
   * unchanged; null (no usable usage) costs 0. Needs `priced`.
   */
  replyUsage?(reply: Uint8Array): TokenUsage | null;
}

export async function serveVpcRoute(
  input: VpcRouteInput,
  spec: VpcRouteSpec,
): Promise<Response> {
  const { request, env, apiKeyAuth, ctx } = input;
  const organizationId = apiKeyAuth.organizationId;
  const settings = await new TenantService(env.DB).getSettings(organizationId);

  const blocked = assertTenantActive(settings);
  if (blocked) return policyError(blocked);
  const spendBlocked = spendLimitMessage(
    apiKeyAuth.spendDisabledUntil,
    settings.spendDisabledUntil as number | undefined,
  );
  if (spendBlocked) return errorBody(402, "spend_limit_exceeded", spendBlocked);

  const parsed = await spec.parse(request);
  if (parsed instanceof Response) return parsed;
  const rawModel = parsed.rawModel.trim();
  if (!rawModel) return invalid("model is required");
  const slash = rawModel.indexOf("/");
  const boundProvider = apiKeyAuth.scopes.defaultProvider
    ? canonicalProviderName(apiKeyAuth.scopes.defaultProvider)
    : undefined;
  const provider = canonicalProviderName(
    slash > 0 ? rawModel.slice(0, slash) : (boundProvider ?? ""),
  );
  const model = slash > 0 ? rawModel.slice(slash + 1) : rawModel;
  if (!provider || !model) return invalid("model must be provider/model");
  // A bound key reaches its provider plus any it lists (as chat, [fork] W16).
  if (boundProvider && !keyMayUseProvider(apiKeyAuth.scopes, provider)) {
    return errorBody(
      403,
      "provider_mismatch",
      `API key is bound to provider '${boundProvider}'; cannot use '${provider}'`,
    );
  }

  const providerError = assertProviderAllowed(
    settings,
    apiKeyAuth.scopes,
    provider,
  );
  if (providerError) return policyError(providerError);
  const config = await getProviderConfig(env, organizationId, provider);
  if (!config) {
    return errorBody(
      400,
      "not_configured",
      `Provider '${provider}' is not configured`,
    );
  }
  if (!config.enabled) {
    return errorBody(
      403,
      "provider_disabled",
      `Provider '${provider}' is disabled`,
    );
  }
  if (!isOpenAICompatibleProvider(provider)) {
    return errorBody(
      400,
      "unsupported_provider",
      `Provider '${provider}' does not support OpenAI ${spec.what}`,
    );
  }
  // [fork] W19: images are priced as output tokens, but a public provider's
  // real bill could differ from that estimate, so only self-hosted (vpc)
  // providers serve them until public providers are reviewed. [fork] W20:
  // the same for the other routes here, which only self-hosted servers have.
  if (config.settings.transport !== "vpc") {
    return errorBody(
      400,
      "unsupported_provider",
      `Provider '${provider}' is not a vpc provider; ${spec.what} are only served by vpc providers`,
    );
  }
  if (spec.enabled && !spec.enabled(config.settings)) {
    return errorBody(
      400,
      "unsupported_provider",
      `Provider '${provider}' does not serve ${spec.what}`,
    );
  }
  const modelError = assertModelAllowed(
    settings,
    apiKeyAuth.scopes,
    provider,
    model,
  );
  if (modelError) return policyError(modelError);

  let fetcher: UpstreamFetcher | undefined;
  try {
    fetcher = resolveFetcher(env, config.settings, organizationId);
  } catch (err) {
    return errorBody(400, "not_configured", (err as Error).message);
  }

  const rate = await checkRateLimits(env, {
    organizationId,
    apiKeyId: apiKeyAuth.keyId,
    settings,
    estimatedTokens: parsed.tokens,
  });
  if (!rate.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Rate limit exceeded. Please retry later.",
          type: "rate_limit_error",
          param: null,
          code: "rate_limit_exceeded",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rate.retryAfter ?? 1),
        },
      },
    );
  }

  const client = new V1OpenAICompatibleClient({
    provider,
    keys: config.keys,
    rotationStrategy: config.settings.rotationStrategy,
    fetcher,
    custom: {
      baseUrl: config.settings.baseUrl as string | undefined,
      imagesPath: config.settings.imagesPath as string | undefined,
    },
  });

  const attempt: ChatAttempt = {
    organizationId,
    apiKeyId: apiKeyAuth.keyId,
    startedAt: Date.now(),
    provider,
    model,
    method: spec.kind,
  };
  // [fork] W21: what a successful request is charged, from its reply when
  // the spec reads one, else `tokens` as output tokens (images).
  const { replyUsage } = spec;
  const { tokens } = parsed;
  const readsReply = spec.priced && replyUsage !== undefined;
  const chargedUsage = (reply: Uint8Array | undefined): TokenUsage | null => {
    if (replyUsage) return reply ? replyUsage(reply) : null;
    return { input: 0, output: tokens, cacheRead: 0, cacheWrite: 0 };
  };
  let recorded = false;
  // One row per request, even when a failure follows a recorded outcome.
  const record: Recorder = (statusCode, errorMessage, reply) => {
    if (recorded) return;
    recorded = true;
    // [fork] W17: a failed request produced nothing.
    const succeeded = statusCode < 400;
    const usage = !succeeded || !spec.priced ? null : chargedUsage(reply);
    const charged = usage !== null;
    ctx.waitUntil(
      (async () => {
        // [fork] W19: priced, not stored as tokens, so these rows stay out
        // of token stats (request-kinds.ts TOKEN_ROWS_SQL).
        const costUsd = usage
          ? computeCostUsd(await getModelPricing(env, provider, model), usage)
          : 0;
        await recordChatRequest(env, attempt, {
          statusCode,
          costUsd,
          units: succeeded ? parsed.units : null,
          ...(errorMessage ? { errorMessage } : {}),
        });
        if (!charged) return;
        // As chat: charge the token bucket, then re-check spend caps.
        await settleTokenUsage(env, {
          organizationId,
          settings,
          actualTokens: usage.input + usage.output,
        }).catch((err) =>
          console.error(`failed to settle ${spec.kind} tokens`, err),
        );
        if (costUsd > 0) {
          await maybeDisableAfterSpend(
            env,
            organizationId,
            apiKeyAuth.keyId,
            apiKeyAuth.scopes,
          ).catch((err) =>
            console.error("failed to evaluate spend limits", err),
          );
        }
      })().catch((err) =>
        console.error(`failed to record ${spec.kind} metrics`, err),
      ),
    );
  };

  // One controller for the upstream call: aborted when the client request is
  // aborted, or when the client cancels the heartbeat stream.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), {
    once: true,
  });
  // [fork] W18: a provider's model alias reaches the upstream under its own id.
  const upstream = spec.send(
    client,
    parsed.body(upstreamModelId(config.settings, model)),
    { signal: abort.signal, contentType: parsed.contentType },
  );

  if (!(parsed.heartbeat ?? spec.heartbeat)) {
    try {
      return await directResponse(await upstream, record, readsReply);
    } catch (err) {
      const message = errorText(err);
      record(502, message);
      return errorBody(502, "upstream_error", message);
    }
  }

  const timing = input.timing ?? {
    graceMs: IMAGE_GRACE_MS,
    heartbeatMs: IMAGE_HEARTBEAT_MS,
  };
  const graceTimer: { id?: ReturnType<typeof setTimeout> } = {};
  const first = await Promise.race([
    upstream.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    ),
    new Promise<"grace">((resolve) => {
      graceTimer.id = setTimeout(() => resolve("grace"), timing.graceMs);
    }),
  ]);
  clearTimeout(graceTimer.id);
  if (first !== "grace") {
    if ("error" in first) {
      const message = errorText(first.error);
      record(502, message);
      return errorBody(502, "upstream_error", message);
    }
    return directResponse(first.response, record, readsReply);
  }
  return heartbeatResponse(
    upstream,
    timing.heartbeatMs,
    timing.maxMs ?? IMAGE_MAX_MS,
    abort,
    record,
    ctx,
    readsReply,
  );
}

/** Record the request's one row; `reply` is the buffered body when read. */
type Recorder = (
  statusCode: number,
  errorMessage?: string,
  reply?: Uint8Array,
) => void;

/**
 * The upstream answered within the grace period: pass its status through.
 * With `readsReply`, the body is buffered so the recorder can price it.
 */
async function directResponse(
  upstream: Response,
  record: Recorder,
  readsReply: boolean,
): Promise<Response> {
  if (!upstream.ok) {
    const message = await upstreamErrorMessage(upstream);
    record(upstream.status, message);
    return errorBody(upstream.status, "upstream_error", message);
  }
  const headers = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  };
  if (!readsReply) {
    record(upstream.status);
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  let reply: Uint8Array;
  try {
    reply = new Uint8Array(await upstream.arrayBuffer());
  } catch (err) {
    const message = errorText(err);
    record(502, message);
    return errorBody(502, "upstream_error", message);
  }
  record(upstream.status, undefined, reply);
  return new Response(reply, { status: upstream.status, headers });
}

/**
 * The upstream is slow: commit a 200 and write a space every `heartbeatMs`
 * so idle timeouts between the client and the Worker do not fire. Leading
 * whitespace is valid JSON, so clients parse the final body unchanged. A
 * failure after the commit becomes an OpenAI-style error object.
 */
function heartbeatResponse(
  upstream: Promise<Response>,
  heartbeatMs: number,
  maxMs: number,
  abort: AbortController,
  record: Recorder,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  readsReply: boolean,
): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const beat = () => writer.write(encoder.encode(" ")).catch(() => {});
  void beat();
  const interval = setInterval(beat, heartbeatMs);
  const stop = () => clearInterval(interval);
  // The client went away: stop beating and cancel the upstream call.
  writer.closed.catch(() => {
    stop();
    abort.abort();
  });

  const writeError = async (code: number, message: string) => {
    await writer.write(
      encoder.encode(
        JSON.stringify({ error: { message, type: "upstream_error", code } }),
      ),
    );
  };

  ctx.waitUntil(
    (async () => {
      const maxTimer: { id?: ReturnType<typeof setTimeout> } = {};
      const timedOut = new Promise<"timeout">((resolve) => {
        maxTimer.id = setTimeout(() => resolve("timeout"), maxMs);
      });
      try {
        const res = await Promise.race([upstream, timedOut]);
        clearTimeout(maxTimer.id);
        stop();
        if (res === "timeout") {
          abort.abort();
          const message = `Upstream did not answer within ${Math.round(maxMs / 1000)} s`;
          record(504, message);
          await writeError(504, message);
          return;
        }
        if (!res.ok) {
          const message = await upstreamErrorMessage(res);
          record(res.status, message);
          await writeError(res.status, message);
        } else {
          // [fork] W21: keep a copy of the reply for the recorder to price.
          const chunks: Uint8Array[] = [];
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (readsReply) chunks.push(value);
              await writer.write(value);
            }
          }
          record(
            res.status,
            undefined,
            readsReply ? concat(chunks) : undefined,
          );
        }
      } catch (err) {
        clearTimeout(maxTimer.id);
        stop();
        const message = errorText(err);
        // 499: the client closed the stream before the reply was delivered.
        record(abort.signal.aborted ? 499 : 502, message);
        await writeError(502, message).catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })(),
  );

  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function spendLimitMessage(
  keyDisabledUntil: number | null | undefined,
  tenantDisabledUntil: number | undefined,
): string | undefined {
  const now = Date.now() / 1000;
  if (keyDisabledUntil && now < keyDisabledUntil) {
    return "API key spend cap reached";
  }
  if (tenantDisabledUntil && now < tenantDisabledUntil) {
    return "Tenant spend limit reached";
  }
  return undefined;
}

async function upstreamErrorMessage(upstream: Response): Promise<string> {
  const text = await upstream.text();
  return `Upstream error (${upstream.status}): ${text.slice(0, ERROR_TEXT_LIMIT)}`;
}

export function invalid(message: string): Response {
  return errorBody(400, "invalid_request_error", message);
}

function policyError(error: PolicyError): Response {
  return errorBody(error.status, error.code, error.message);
}

function errorBody(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: code, code } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
