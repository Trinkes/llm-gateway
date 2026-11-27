// [fork] W17: embeddings record one `embedding` row per upstream call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { recordChatRequest } from "~/src/metrics/request-logger";
import { embeddingsV2 } from "~/src/requests/embeddings_v2";
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

vi.mock("~/src/metrics/request-logger", () => ({
  recordChatRequest: vi.fn().mockResolvedValue(undefined),
}));

const mockGetProviderConfig = vi.mocked(getProviderConfig);
const mockRecord = vi.mocked(recordChatRequest);

const auth = {
  keyId: "key_1",
  organizationId: "org_1",
  scopes: {},
} as unknown as ApiKeyAuth;

const openai: DecryptedProviderConfig = {
  id: "pcfg_openai",
  provider: "openai",
  name: "openai",
  enabled: true,
  keys: ["sk-test"],
  settings: {},
  updatedAt: 1,
};

const pending: Promise<unknown>[] = [];

function embed(
  body: unknown = { model: "openai/text-embed", input: "hi" },
  apiKeyAuth: ApiKeyAuth = auth,
) {
  return embeddingsV2({
    request: new Request("https://gw.test/v1/embeddings", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env: {} as Env,
    apiKeyAuth,
    ctx: { waitUntil: (p) => void pending.push(p) },
  });
}

function upstream(response: Response | Error) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("embeddingsV2 recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderConfig.mockResolvedValue(openai);
    pending.length = 0;
    tenant.settings = {};
  });
  afterEach(() => vi.restoreAllMocks());

  it("records an embedding row with usage.prompt_tokens as input", async () => {
    const payload = JSON.stringify({
      data: [{ embedding: [0.1] }],
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
    upstream(
      new Response(payload, {
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await embed();
    await Promise.all(pending);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(payload);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, attempt, outcome] = mockRecord.mock.calls[0];
    expect(attempt).toMatchObject({
      organizationId: "org_1",
      apiKeyId: "key_1",
      provider: "openai",
      model: "text-embed",
      method: "embedding",
    });
    expect(outcome).toEqual({
      statusCode: 200,
      usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it.each([
    ["no usage block", JSON.stringify({ data: [] })],
    [
      "non-numeric prompt_tokens",
      JSON.stringify({ usage: { prompt_tokens: "x" } }),
    ],
    ["non-JSON body", "not json"],
  ])("records zero input tokens for %s", async (_name, payload) => {
    upstream(new Response(payload));

    const res = await embed();
    await Promise.all(pending);

    expect(await res.text()).toBe(payload);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 200,
      usage: { input: 0 },
    });
  });

  it("records an upstream error status", async () => {
    upstream(new Response("boom", { status: 429 }));

    const res = await embed();
    await Promise.all(pending);

    expect(res.status).toBe(502);
    expect(mockRecord.mock.calls[0][2]).toEqual({
      statusCode: 429,
      errorMessage: "Upstream error (429): boom",
    });
  });

  it("records a transport failure as 502", async () => {
    upstream(new Error("connect refused"));

    const res = await embed();
    await Promise.all(pending);

    expect(res.status).toBe(502);
    expect(mockRecord.mock.calls[0][2]).toEqual({
      statusCode: 502,
      errorMessage: "connect refused",
    });
  });

  it("records a non-Error transport failure by its string form", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue("nope");

    await embed();
    await Promise.all(pending);

    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      errorMessage: "nope",
    });
  });

  it("logs instead of failing when the row cannot be written", async () => {
    mockRecord.mockRejectedValueOnce(new Error("d1 down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    upstream(new Response(JSON.stringify({ usage: { prompt_tokens: 1 } })));

    const res = await embed();
    await Promise.all(pending);

    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalledWith(
      "failed to record embedding metrics",
      expect.any(Error),
    );
  });

  it("records nothing when the request is rejected before upstream", async () => {
    const res = await embed({ input: "hi" });
    await Promise.all(pending);

    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("defaults the content type to JSON when upstream sends none", async () => {
    upstream(new Response(new Uint8Array([123, 125])));

    const res = await embed();

    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("passes a custom base URL and embeddings path to the client", async () => {
    mockGetProviderConfig.mockResolvedValue({
      ...openai,
      settings: {
        baseUrl: "http://emb.test",
        embeddingsPath: "/v1/embed",
      },
    });
    const fetchSpy = upstream(new Response("{}"));

    await embed();

    expect(fetchSpy.mock.calls[0][0]).toBe("http://emb.test/v1/embed");
  });
});

async function errorOf(res: Response) {
  const json = (await res.json()) as { error: { code: string } };
  return [res.status, json.error.code];
}

describe("embeddingsV2 validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderConfig.mockResolvedValue(openai);
    tenant.settings = {};
    pending.length = 0;
  });

  it("rejects a suspended tenant", async () => {
    tenant.settings = { status: "suspended" };
    expect(await errorOf(await embed())).toEqual([400, "tenant_suspended"]);
  });

  it("rejects an unparsable body", async () => {
    expect(await errorOf(await embed("{nope"))).toEqual([
      400,
      "invalid_request_error",
    ]);
  });

  it("rejects a missing or non-string model", async () => {
    expect(await errorOf(await embed({ model: 5 }))).toEqual([
      400,
      "invalid_request_error",
    ]);
  });

  it("rejects a bare model without a bound provider", async () => {
    expect(await errorOf(await embed({ model: "text-embed" }))).toEqual([
      400,
      "invalid_request_error",
    ]);
  });

  it("rejects a provider/ prefix with no model", async () => {
    expect(await errorOf(await embed({ model: "openai/" }))).toEqual([
      400,
      "invalid_request_error",
    ]);
  });

  it("resolves a bare model through the key's bound provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const bound = {
      ...auth,
      scopes: { defaultProvider: "openai" },
    } as unknown as ApiKeyAuth;

    const res = await embed({ model: "text-embed" }, bound);
    await Promise.all(pending);

    expect(res.status).toBe(200);
    expect(mockRecord.mock.calls[0][1]).toMatchObject({
      provider: "openai",
      model: "text-embed",
    });
    vi.restoreAllMocks();
  });

  it("rejects a provider outside the key's scopes", async () => {
    const scoped = {
      ...auth,
      scopes: { providers: ["other"] },
    } as unknown as ApiKeyAuth;
    expect(await errorOf(await embed(undefined, scoped))).toEqual([
      400,
      "provider_not_allowed",
    ]);
  });

  it("rejects an unconfigured provider", async () => {
    mockGetProviderConfig.mockResolvedValue(null as never);
    expect(await errorOf(await embed())).toEqual([400, "not_configured"]);
  });

  it("rejects a disabled provider", async () => {
    mockGetProviderConfig.mockResolvedValue({ ...openai, enabled: false });
    expect(await errorOf(await embed())).toEqual([400, "provider_disabled"]);
  });

  it("rejects a provider that is not OpenAI-compatible", async () => {
    expect(
      await errorOf(await embed({ model: "anthropic/claude", input: "x" })),
    ).toEqual([400, "unsupported_provider"]);
  });

  it("rejects a model outside the allowlist", async () => {
    tenant.settings = { modelAllowlist: ["openai/other"] };
    expect(await errorOf(await embed())).toEqual([400, "model_not_allowed"]);
  });
});
