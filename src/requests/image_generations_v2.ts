// [fork] W12: OpenAI-compatible image generations for OpenAI-compatible
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

const ERROR_TEXT_LIMIT = 512;

export interface ImageGenerationsInput {
  request: Request;
  env: Env;
  apiKeyAuth: ApiKeyAuth;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  /** Tests only; defaults to IMAGE_GRACE_MS / IMAGE_HEARTBEAT_MS. */
  timing?: { graceMs: number; heartbeatMs: number };
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
    custom:
      config.settings.baseUrl || config.settings.accountId
        ? {
            baseUrl: config.settings.baseUrl as string | undefined,
            accountId: config.settings.accountId as string | undefined,
            imagesPath: config.settings.imagesPath as string | undefined,
          }
        : undefined,
  });

  const attempt: ChatAttempt = {
    organizationId,
    apiKeyId: apiKeyAuth.keyId,
    startedAt: Date.now(),
    provider,
    model,
    method: "image",
  };
  const record = (statusCode: number, errorMessage?: string) => {
    ctx.waitUntil(
      recordChatRequest(env, attempt, {
        statusCode,
        costUsd: 0,
        ...(errorMessage ? { errorMessage } : {}),
      }).catch((err) => console.error("failed to record image metrics", err)),
    );
  };

  let upstream: Response;
  try {
    upstream = await client.imageGenerations(
      JSON.stringify({ ...body, model }),
      { signal: request.signal },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(502, message);
    return errorBody(502, "upstream_error", message);
  }
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
