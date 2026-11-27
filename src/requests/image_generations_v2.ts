// [fork] W15: OpenAI-compatible image generations for OpenAI-compatible
// providers (typically a self-hosted image server behind a vpc binding).
import { TenantService } from "../db/tenant";
import { getProviderConfig } from "../llm/credential-store";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
  type PolicyError,
} from "../llm/policy";
import {
  canonicalProviderName,
  isOpenAICompatibleProvider,
} from "../llm/provider-registry";
import { checkRateLimits } from "../llm/rate-limit";
import { resolveFetcher, type UpstreamFetcher } from "../llm/transport";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import { recordChatRequest, type ChatAttempt } from "../metrics/request-logger";
import { ApiKeyAuth } from "../types";

/** Wait this long for upstream headers before committing a 200 heartbeat. */
export const IMAGE_GRACE_MS = 15_000;
/** Interval between heartbeat spaces once the 200 is committed. */
export const IMAGE_HEARTBEAT_MS = 10_000;
/** Give up on an upstream that has not answered after this long (hung GPU). */
export const IMAGE_MAX_MS = 600_000;

const ERROR_TEXT_LIMIT = 512;

export interface ImageGenerationsInput {
  request: Request;
  env: Env;
  apiKeyAuth: ApiKeyAuth;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  /** Tests only; defaults to IMAGE_GRACE_MS / IMAGE_HEARTBEAT_MS. */
  timing?: { graceMs: number; heartbeatMs: number; maxMs?: number };
}

interface ImageRequestBody {
  model?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

export async function imageGenerationsV2(
  input: ImageGenerationsInput,
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

  let body: ImageRequestBody;
  try {
    const json = await request.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return invalid("Invalid request body");
    }
    body = json as ImageRequestBody;
  } catch {
    return invalid("Invalid request body");
  }
  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!rawModel) return invalid("model is required");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return invalid("prompt is required");
  }
  const slash = rawModel.indexOf("/");
  const boundProvider = apiKeyAuth.scopes.defaultProvider
    ? canonicalProviderName(apiKeyAuth.scopes.defaultProvider)
    : undefined;
  const provider = canonicalProviderName(
    slash > 0 ? rawModel.slice(0, slash) : (boundProvider ?? ""),
  );
  const model = slash > 0 ? rawModel.slice(slash + 1) : rawModel;
  if (!provider || !model) return invalid("model must be provider/model");
  // A key bound to a provider only ever routes to that provider (as chat).
  if (boundProvider && provider !== boundProvider) {
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
      `Provider '${provider}' does not support OpenAI image generations`,
    );
  }
  // Image rows are recorded at cost 0 and charge no token budget, so only
  // self-hosted (vpc) providers may serve them: a paid public provider here
  // would bypass spend caps.
  if (config.settings.transport !== "vpc") {
    return errorBody(
      400,
      "unsupported_provider",
      `Provider '${provider}' is not a vpc provider; image generations are only served by vpc providers`,
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
    estimatedTokens: 0,
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
    method: "image",
  };
  let recorded = false;
  // One row per request, even when a failure follows a recorded outcome.
  const record = (statusCode: number, errorMessage?: string) => {
    if (recorded) return;
    recorded = true;
    ctx.waitUntil(
      recordChatRequest(env, attempt, {
        statusCode,
        costUsd: 0,
        ...(errorMessage ? { errorMessage } : {}),
      }).catch((err) => console.error("failed to record image metrics", err)),
    );
  };

  const timing = input.timing ?? {
    graceMs: IMAGE_GRACE_MS,
    heartbeatMs: IMAGE_HEARTBEAT_MS,
  };
  // One controller for the upstream call: aborted when the client request is
  // aborted, or when the client cancels the heartbeat stream.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), {
    once: true,
  });
  const upstream = client.imageGenerations(JSON.stringify({ ...body, model }), {
    signal: abort.signal,
  });
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
    return directResponse(first.response, record);
  }
  return heartbeatResponse(
    upstream,
    timing.heartbeatMs,
    timing.maxMs ?? IMAGE_MAX_MS,
    abort,
    record,
    ctx,
  );
}

type Recorder = (statusCode: number, errorMessage?: string) => void;

/** The upstream answered within the grace period: pass its status through. */
async function directResponse(
  upstream: Response,
  record: Recorder,
): Promise<Response> {
  if (!upstream.ok) {
    const message = await upstreamErrorMessage(upstream);
    record(upstream.status, message);
    return errorBody(upstream.status, "upstream_error", message);
  }
  record(upstream.status);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
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
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
          }
          record(res.status);
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

function invalid(message: string): Response {
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
