// [fork] W15: OpenAI-compatible image generations over a vpc provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { checkRateLimits } from "~/src/llm/rate-limit";
import { getModelPricing } from "~/src/metrics/cost-tracker";
import { recordChatRequest } from "~/src/metrics/request-logger";
import { imageGenerationsV2 } from "~/src/requests/image_generations_v2";
import type { ApiKeyAuth } from "~/src/types";

const tenant = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock("~/src/db/tenant", () => ({
  TenantService: class {
    async getSettings() {
      return tenant.settings;
    }
  },
}));

vi.mock("~/src/llm/credential-store", () => ({
  getProviderConfig: vi.fn(),
}));

vi.mock("~/src/llm/rate-limit", () => ({
  checkRateLimits: vi.fn(),
}));

vi.mock("~/src/metrics/cost-tracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/src/metrics/cost-tracker")>()),
  getModelPricing: vi.fn(),
}));

vi.mock("~/src/metrics/request-logger", () => ({
  recordChatRequest: vi.fn().mockResolvedValue(undefined),
}));

const mockGetProviderConfig = vi.mocked(getProviderConfig);
const mockCheckRateLimits = vi.mocked(checkRateLimits);
const mockRecord = vi.mocked(recordChatRequest);
const mockGetModelPricing = vi.mocked(getModelPricing);

/** $40 per 1M output tokens, OpenAI's image output rate. */
const IMAGE_PRICING = {
  provider: "local-box",
  model: "z-image-turbo",
  inputPer1m: 0,
  outputPer1m: 40,
  cacheReadPer1m: 0,
  cacheWritePer1m: 0,
};

const baseAuth = {
  keyId: "key_1",
  organizationId: "org_1",
  scopes: {},
  spendDisabledUntil: null,
} as unknown as ApiKeyAuth;

const imageBox: DecryptedProviderConfig = {
  id: "pcfg_image",
  provider: "local-box",
  name: "local-box",
  enabled: true,
  keys: [],
  settings: {
    baseUrl: "http://127.0.0.1:11436",
    transport: "vpc",
    vpcBinding: "IMAGEGEN",
  },
  updatedAt: 1,
};

const IMAGE = { created: 1, data: [{ b64_json: "AAAA" }] };

function imageResponse(): Response {
  return new Response(JSON.stringify(IMAGE), {
    headers: { "content-type": "application/json" },
  });
}

const pending: Promise<unknown>[] = [];

function generate(
  env: object,
  options: {
    body?: unknown;
    apiKeyAuth?: ApiKeyAuth;
    timing?: { graceMs: number; heartbeatMs: number; maxMs?: number };
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const body =
    "body" in options
      ? options.body
      : {
          model: "local-box/z-image-turbo",
          prompt: "a red bicycle",
          size: "1536x1024",
          n: 1,
        };
  return imageGenerationsV2({
    request: new Request("https://gw.test/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: options.signal,
    }),
    env: env as Env,
    apiKeyAuth: options.apiKeyAuth ?? baseAuth,
    ctx: { waitUntil: (p) => void pending.push(p) },
    timing: options.timing,
  });
}

function boxEnv(binding: { fetch: unknown }) {
  return { VPC_BINDINGS: "IMAGEGEN:org_1", IMAGEGEN: binding };
}

async function settled() {
  await Promise.all(pending);
}

describe("imageGenerationsV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderConfig.mockResolvedValue(imageBox);
    mockCheckRateLimits.mockResolvedValue({ allowed: true });
    mockGetModelPricing.mockResolvedValue(IMAGE_PRICING);
    tenant.settings = {};
    pending.length = 0;
  });

  it("forwards to the binding and streams the body back", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    const res = await generate(boxEnv(binding));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(IMAGE);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = binding.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11436/v1/images/generations");
    expect(JSON.parse(init.body)).toEqual({
      model: "z-image-turbo",
      prompt: "a red bicycle",
      size: "1536x1024",
      n: 1,
    });
  });

  // [fork] W18
  it("sends the upstream id for a model alias", async () => {
    mockGetProviderConfig.mockResolvedValue({
      ...imageBox,
      settings: {
        ...imageBox.settings,
        modelAliases: { "z-image-turbo": "sd-cpp-local" },
      },
    });
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding));
    await settled();

    expect(JSON.parse(binding.fetch.mock.calls[0][1].body).model).toBe(
      "sd-cpp-local",
    );
    expect(mockRecord.mock.calls[0][1]).toMatchObject({
      model: "z-image-turbo",
    });
  });

  it("records an image row", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding));
    await settled();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, attempt, outcome] = mockRecord.mock.calls[0];
    expect(attempt).toMatchObject({
      organizationId: "org_1",
      apiKeyId: "key_1",
      provider: "local-box",
      model: "z-image-turbo",
      method: "image",
    });
    // Default body: 1536x1024, no quality (high) → 6240 tokens at $40 / 1M.
    expect(outcome).toEqual({ statusCode: 200, costUsd: 0.2496, units: 1 });
    expect(mockGetModelPricing).toHaveBeenCalledWith(
      expect.anything(),
      "local-box",
      "z-image-turbo",
    );
  });

  it("prices by size, quality and n", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding), {
      body: {
        model: "local-box/z-image-turbo",
        prompt: "a cat",
        size: "1024x1024",
        quality: "low",
        n: 2,
      },
    });
    await settled();

    // 2 × 272 tokens at $40 / 1M.
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ costUsd: 0.02176 });
  });

  it("keeps image tokens out of the token columns", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding));
    await settled();

    expect(mockRecord.mock.calls[0][2]).not.toHaveProperty("usage");
  });

  it("records a failed generation at cost 0 without a price lookup", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    };

    await generate(boxEnv(binding));
    await settled();

    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 500,
      costUsd: 0,
    });
    expect(mockGetModelPricing).not.toHaveBeenCalled();
  });

  it.each([
    [4, 4],
    [undefined, 1],
    [0, 1],
    [11, 1],
    ["2", 1],
  ])("records units for n=%j as %i", async (n, units) => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding), {
      body: { model: "local-box/z-image-turbo", prompt: "a cat", n },
    });
    await settled();

    expect(mockRecord.mock.calls[0][2]).toMatchObject({ units });
  });

  it("records units only for successful generations", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    };

    await generate(boxEnv(binding), {
      body: { model: "local-box/z-image-turbo", prompt: "a cat", n: 3 },
    });
    await settled();

    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 500,
      units: null,
    });
  });

  it("logs instead of failing when the request row cannot be written", async () => {
    mockRecord.mockRejectedValueOnce(new Error("d1 down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    const res = await generate(boxEnv(binding));
    await settled();

    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalledWith(
      "failed to record image metrics",
      expect.any(Error),
    );
    errors.mockRestore();
  });

  it("estimates image tokens for the rate limiter", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding), {
      body: {
        model: "local-box/z-image-turbo",
        prompt: "a cat",
        size: "1024x1024",
        quality: "low",
        n: 2,
      },
    });

    expect(mockCheckRateLimits).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimits.mock.calls[0][1]).toMatchObject({
      organizationId: "org_1",
      apiKeyId: "key_1",
      estimatedTokens: 544,
    });
  });

  it("keeps the upstream status within the grace period", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad size" } }), {
          status: 400,
        }),
      ),
    };

    const res = await generate(boxEnv(binding));
    const body = (await res.json()) as {
      error: { type: string; message: string };
    };
    await settled();

    expect(res.status).toBe(400);
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("bad size");
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 400 });
  });

  it("returns 502 when the upstream call throws", async () => {
    const binding = {
      fetch: vi.fn().mockRejectedValue(new Error("tunnel down")),
    };

    const res = await generate(boxEnv(binding));
    const body = (await res.json()) as {
      error: { type: string; message: string };
    };
    await settled();

    expect(res.status).toBe(502);
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("tunnel down");
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 502 });
  });

  it.each([
    ["no model", {}],
    ["no prompt", { model: "local-box/z-image-turbo" }],
    ["empty prompt", { model: "local-box/z-image-turbo", prompt: "  " }],
    ["non-string prompt", { model: "local-box/z-image-turbo", prompt: 42 }],
    ["a bare model without a bound provider", { model: "z", prompt: "x" }],
    ["invalid JSON", "{nope"],
    ["an array body", "[]"],
    ["a null body", "null"],
  ])("rejects a body with %s before any upstream call", async (_, body) => {
    const binding = { fetch: vi.fn() };

    const res = await generate(boxEnv(binding), { body });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("invalid_request_error");
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(mockCheckRateLimits).not.toHaveBeenCalled();
  });

  it("uses the key's default provider for a bare model", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };
    const apiKeyAuth = {
      ...baseAuth,
      scopes: { defaultProvider: "local-box" },
    } as ApiKeyAuth;

    const res = await generate(boxEnv(binding), {
      apiKeyAuth,
      body: { model: "z-image-turbo", prompt: "a cat" },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(binding.fetch.mock.calls[0][1].body).model).toBe(
      "z-image-turbo",
    );
  });

  // A key bound to a provider only ever routes to that provider (as chat).
  it("refuses a key bound to another provider", async () => {
    const binding = { fetch: vi.fn() };
    const apiKeyAuth = {
      ...baseAuth,
      scopes: { defaultProvider: "local-chat" },
    } as ApiKeyAuth;

    const res = await generate(boxEnv(binding), { apiKeyAuth });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("provider_mismatch");
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(mockCheckRateLimits).not.toHaveBeenCalled();
  });

  it("accepts a bound key that lists the provider", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };
    const apiKeyAuth = {
      ...baseAuth,
      scopes: {
        defaultProvider: "local-chat",
        providers: ["local-chat", "local-box"],
      },
    } as ApiKeyAuth;

    const res = await generate(boxEnv(binding), { apiKeyAuth });

    expect(res.status).toBe(200);
  });

  it("accepts a bound key naming its own provider explicitly", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };
    const apiKeyAuth = {
      ...baseAuth,
      scopes: { defaultProvider: "local-box" },
    } as ApiKeyAuth;

    const res = await generate(boxEnv(binding), { apiKeyAuth });

    expect(res.status).toBe(200);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimits.mockResolvedValue({ allowed: false, retryAfter: 7 });
    const binding = { fetch: vi.fn() };

    const res = await generate(boxEnv(binding));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("defaults Retry-After to 1 second", async () => {
    mockCheckRateLimits.mockResolvedValue({ allowed: false });

    const res = await generate(boxEnv({ fetch: vi.fn() }));

    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("refuses a key without the provider in scope", async () => {
    const binding = { fetch: vi.fn() };
    const apiKeyAuth = {
      ...baseAuth,
      scopes: { providers: ["other"] },
    } as ApiKeyAuth;

    const res = await generate(boxEnv(binding), { apiKeyAuth });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("provider_not_allowed");
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("refuses a model outside the key's model list", async () => {
    const apiKeyAuth = {
      ...baseAuth,
      scopes: { models: ["local-box/other-model"] },
    } as ApiKeyAuth;

    const res = await generate(boxEnv({ fetch: vi.fn() }), { apiKeyAuth });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("model_not_allowed");
  });

  it("refuses a key whose spend cap is reached", async () => {
    const apiKeyAuth = {
      ...baseAuth,
      spendDisabledUntil: Date.now() / 1000 + 60,
    } as ApiKeyAuth;

    const res = await generate(boxEnv({ fetch: vi.fn() }), { apiKeyAuth });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("spend_limit_exceeded");
  });

  it("refuses a tenant whose spend limit is reached", async () => {
    tenant.settings = { spendDisabledUntil: Date.now() / 1000 + 60 };

    const res = await generate(boxEnv({ fetch: vi.fn() }));

    expect(res.status).toBe(402);
  });

  it("refuses a suspended tenant", async () => {
    tenant.settings = { status: "suspended" };

    const res = await generate(boxEnv({ fetch: vi.fn() }));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("tenant_suspended");
  });

  it("returns not_configured for an unknown provider", async () => {
    mockGetProviderConfig.mockResolvedValue(null);

    const res = await generate(boxEnv({ fetch: vi.fn() }));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("not_configured");
  });

  it("refuses a disabled provider", async () => {
    mockGetProviderConfig.mockResolvedValue({ ...imageBox, enabled: false });

    const res = await generate(boxEnv({ fetch: vi.fn() }));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("provider_disabled");
  });

  it("refuses a provider that is not OpenAI-compatible", async () => {
    mockGetProviderConfig.mockResolvedValue({
      ...imageBox,
      provider: "anthropic",
    });

    const res = await generate(boxEnv({ fetch: vi.fn() }), {
      body: { model: "anthropic/claude", prompt: "a cat" },
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("unsupported_provider");
  });

  it("defaults the content type of a body-less upstream reply", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    };

    const res = await generate(boxEnv(binding));

    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("reports a non-Error upstream failure as text", async () => {
    const binding = { fetch: vi.fn().mockRejectedValue("socket hang up") };

    const res = await generate(boxEnv(binding));
    const body = (await res.json()) as { error: { message: string } };

    expect(res.status).toBe(502);
    expect(body.error.message).toBe("socket hang up");
  });

  it("aborts the upstream call when the client request is aborted", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const binding = {
      fetch: vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamSignal = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    };
    const client = new AbortController();

    const pendingRes = generate(boxEnv(binding), { signal: client.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.abort();
    const res = await pendingRes;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.status).toBe(502);
  });

  it("returns not_configured when the binding is not allowlisted", async () => {
    const binding = { fetch: vi.fn() };

    const res = await generate({ VPC_BINDINGS: "", IMAGEGEN: binding });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("not_configured");
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(mockCheckRateLimits).not.toHaveBeenCalled();
  });
});

describe("imageGenerationsV2 with a public provider", () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
    mockCheckRateLimits.mockResolvedValue({ allowed: true });
    mockGetModelPricing.mockResolvedValue(IMAGE_PRICING);
    tenant.settings = {};
    pending.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  // Image rows are recorded at cost 0, so a paid public provider would bypass
  // spend caps: only vpc (self-hosted) providers may serve this route.
  it("refuses a public provider", async () => {
    mockGetProviderConfig.mockResolvedValue({
      ...imageBox,
      provider: "openai",
      keys: ["sk-test"],
      settings: {},
    });

    const res = await generate(
      {},
      { body: { model: "openai/gpt-image-1", prompt: "a cat" } },
    );
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("unsupported_provider");
    expect(globalFetch).not.toHaveBeenCalled();
    expect(mockCheckRateLimits).not.toHaveBeenCalled();
  });
});

describe("imageGenerationsV2 heartbeat", () => {
  const timing = { graceMs: 20, heartbeatMs: 10 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderConfig.mockResolvedValue(imageBox);
    mockCheckRateLimits.mockResolvedValue({ allowed: true });
    mockGetModelPricing.mockResolvedValue(IMAGE_PRICING);
    tenant.settings = {};
    pending.length = 0;
  });

  function slowUpstream(settle: () => Promise<Response>, afterMs = 60) {
    let signal: AbortSignal | undefined;
    const binding = {
      fetch: vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((resolve, reject) => {
          setTimeout(() => settle().then(resolve, reject), afterMs);
        });
      }),
    };
    return { binding, signal: () => signal };
  }

  it("sends spaces then the image when the upstream is slow", async () => {
    let answered = false;
    const { binding } = slowUpstream(async () => {
      answered = true;
      return imageResponse();
    });

    const res = await generate(boxEnv(binding), { timing });

    expect(answered).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(text).toMatch(/^ {2,}\{"created":1/);
    expect(JSON.parse(text)).toEqual(IMAGE);
    await settled();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 200,
      costUsd: 0.2496,
    });
  });

  it("answers normally when the upstream is fast", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    const res = await generate(boxEnv(binding), { timing });

    expect((await res.text()).startsWith("{")).toBe(true);
  });

  it("reports an error object after the commit", async () => {
    const { binding } = slowUpstream(
      async () => new Response("boom", { status: 500 }),
    );

    const res = await generate(boxEnv(binding), { timing });
    const parsed = JSON.parse(await res.text());
    await settled();

    expect(res.status).toBe(200);
    expect(parsed.error).toEqual({
      message: expect.stringContaining("boom"),
      type: "upstream_error",
      code: 500,
    });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 500,
      costUsd: 0,
    });
  });

  it("reports 502 when the upstream throws after the commit", async () => {
    const { binding } = slowUpstream(async () => {
      throw new Error("tunnel closed");
    });

    const res = await generate(boxEnv(binding), { timing });
    const parsed = JSON.parse(await res.text());
    await settled();

    expect(res.status).toBe(200);
    expect(parsed.error).toEqual({
      message: "tunnel closed",
      type: "upstream_error",
      code: 502,
    });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 502 });
  });

  it("aborts the upstream when the client goes away", async () => {
    const clears = vi.spyOn(globalThis, "clearInterval");
    const { binding, signal } = slowUpstream(async () => imageResponse(), 500);

    const res = await generate(boxEnv(binding), { timing });
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(new TextDecoder().decode(first.value)).toBe(" ");
    expect(signal()?.aborted).toBe(true);
    expect(clears).toHaveBeenCalled();
    clears.mockRestore();
  });

  it("stops cleanly when the client leaves before the upstream answers", async () => {
    const { binding } = slowUpstream(async () => imageResponse(), 60);

    const res = await generate(boxEnv(binding), { timing });
    await res.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settled();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 499 });
  });

  it("records one row when the error cannot reach a departed client", async () => {
    const { binding } = slowUpstream(
      async () => new Response("boom", { status: 500 }),
    );

    const res = await generate(boxEnv(binding), { timing });
    await res.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settled();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 500 });
  });

  it("gives up with a 504 error object after the maximum wait", async () => {
    const { binding, signal } = slowUpstream(async () => imageResponse(), 5000);

    const res = await generate(boxEnv(binding), {
      timing: { ...timing, maxMs: 60 },
    });
    const parsed = JSON.parse(await res.text());
    await settled();

    expect(res.status).toBe(200);
    expect(parsed.error).toEqual({
      message: expect.stringContaining("did not answer"),
      type: "upstream_error",
      code: 504,
    });
    expect(signal()?.aborted).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 504 });
  });

  it("closes with only spaces when a slow upstream sends no body", async () => {
    const { binding } = slowUpstream(
      async () => new Response(null, { status: 200 }),
    );

    const res = await generate(boxEnv(binding), { timing });

    expect((await res.text()).trim()).toBe("");
  });
});
