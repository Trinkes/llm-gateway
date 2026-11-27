// [fork] W12: OpenAI-compatible image generations over a vpc provider.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { checkRateLimits } from "~/src/llm/rate-limit";
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

vi.mock("~/src/metrics/request-logger", () => ({
  recordChatRequest: vi.fn().mockResolvedValue(undefined),
}));

const mockGetProviderConfig = vi.mocked(getProviderConfig);
const mockCheckRateLimits = vi.mocked(checkRateLimits);
const mockRecord = vi.mocked(recordChatRequest);

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
  options: { body?: unknown; apiKeyAuth?: ApiKeyAuth } = {},
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
    }),
    env: env as Env,
    apiKeyAuth: options.apiKeyAuth ?? baseAuth,
    ctx: { waitUntil: (p) => void pending.push(p) },
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
    expect(outcome).toEqual({ statusCode: 200, costUsd: 0 });
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

  it("charges one request to the rate limiter without a token estimate", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(imageResponse()) };

    await generate(boxEnv(binding));

    expect(mockCheckRateLimits).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimits.mock.calls[0][1]).toMatchObject({
      organizationId: "org_1",
      apiKeyId: "key_1",
      estimatedTokens: 0,
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
