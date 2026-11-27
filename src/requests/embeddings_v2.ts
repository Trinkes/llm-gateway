import { TenantService } from "../db/tenant";
import { getProviderConfig } from "../llm/credential-store";
import { upstreamModelId } from "../llm/model-aliases";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
} from "../llm/policy";
import {
  canonicalProviderName,
  isOpenAICompatibleProvider,
} from "../llm/provider-registry";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import { recordChatRequest, type ChatAttempt } from "../metrics/request-logger";
import { ApiKeyAuth } from "../types";

export interface EmbeddingsInput {
  request: Request;
  env: Env;
  apiKeyAuth: ApiKeyAuth;
  ctx: { waitUntil(promise: Promise<unknown>): void }; // [fork] W17
}

export async function embeddingsV2(input: EmbeddingsInput): Promise<Response> {
  const { request, env, apiKeyAuth, ctx } = input;
  const organizationId = apiKeyAuth.organizationId;
  const settings = await new TenantService(env.DB).getSettings(organizationId);
  const blocked = assertTenantActive(settings);
  if (blocked) return errorBody(blocked.code, blocked.message);

  let body: { model?: unknown; input?: unknown };
  try {
    body = (await request.json()) as { model?: unknown; input?: unknown };
  } catch {
    return errorBody("invalid_request_error", "Invalid request body");
  }
  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!rawModel) return errorBody("invalid_request_error", "model is required");
  const slash = rawModel.indexOf("/");
  const boundProvider = apiKeyAuth.scopes.defaultProvider
    ? canonicalProviderName(apiKeyAuth.scopes.defaultProvider)
    : undefined;
  const provider = canonicalProviderName(
    slash > 0 ? rawModel.slice(0, slash) : (boundProvider ?? ""),
  );
  const model = slash > 0 ? rawModel.slice(slash + 1) : rawModel;
  if (!provider || !model) {
    return errorBody("invalid_request_error", "model must be provider/model");
  }
  const providerError = assertProviderAllowed(
    settings,
    apiKeyAuth.scopes,
    provider,
  );
  if (providerError)
    return errorBody(providerError.code, providerError.message);
  const config = await getProviderConfig(env, organizationId, provider);
  if (!config)
    return errorBody(
      "not_configured",
      `Provider '${provider}' is not configured`,
    );
  if (!config.enabled)
    return errorBody("provider_disabled", `Provider '${provider}' is disabled`);
  if (!isOpenAICompatibleProvider(provider)) {
    return errorBody(
      "unsupported_provider",
      `Provider '${provider}' does not support OpenAI embeddings`,
    );
  }
  const modelError = assertModelAllowed(
    settings,
    apiKeyAuth.scopes,
    provider,
    model,
  );
  if (modelError) return errorBody(modelError.code, modelError.message);

  const client = new V1OpenAICompatibleClient({
    provider,
    keys: config.keys,
    rotationStrategy: config.settings.rotationStrategy,
    custom:
      config.settings.baseUrl || config.settings.accountId
        ? {
            baseUrl: config.settings.baseUrl as string | undefined,
            accountId: config.settings.accountId as string | undefined,
            embeddingsPath: config.settings.embeddingsPath as
              string | undefined,
          }
        : undefined,
  });
  // [fork] W17: one `embedding` row per upstream call, like chat.
  const attempt: ChatAttempt = {
    organizationId,
    apiKeyId: apiKeyAuth.keyId,
    startedAt: Date.now(),
    provider,
    model: model,
    method: "embedding",
  };
  // [fork] W17
  const record = (outcome: Parameters<typeof recordChatRequest>[2]) =>
    ctx.waitUntil(
      recordChatRequest(env, attempt, outcome).catch((err) =>
        console.error("failed to record embedding metrics", err),
      ),
    );
  let upstream: Response;
  try {
    upstream = await client.embeddings(
      JSON.stringify({
        ...body,
        model: upstreamModelId(config.settings, model), // [fork] W18
      }),
      { signal: request.signal },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record({ statusCode: 502, errorMessage: message });
    return errorBody("upstream_error", message);
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    const message = `Upstream error (${upstream.status}): ${text.slice(0, 512)}`;
    record({ statusCode: upstream.status, errorMessage: message });
    return errorBody("upstream_error", message);
  }
  // Buffered (not streamed): the usage is read from the body to record it;
  // embeddings replies are small JSON.
  const text = await upstream.text();
  record({
    statusCode: upstream.status,
    usage: {
      input: promptTokens(text),
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  });
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

/** `usage.prompt_tokens` of an embeddings reply; 0 when absent or malformed. */
function promptTokens(text: string): number {
  try {
    const tokens = (JSON.parse(text) as { usage?: { prompt_tokens?: unknown } })
      .usage?.prompt_tokens;
    return typeof tokens === "number" && tokens > 0 ? tokens : 0;
  } catch {
    return 0;
  }
}

function errorBody(code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: code, code } }),
    {
      status: code === "upstream_error" ? 502 : 400,
      headers: { "Content-Type": "application/json" },
    },
  );
}
