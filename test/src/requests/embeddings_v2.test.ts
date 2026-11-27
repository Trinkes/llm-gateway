// [fork] W17: embeddings record one `embedding` row per upstream call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { recordChatRequest } from "~/src/metrics/request-logger";
import { embeddingsV2 } from "~/src/requests/embeddings_v2";
import type { ApiKeyAuth } from "~/src/types";

vi.mock("~/src/db/tenant", () => ({
  TenantService: class {
    async getSettings() {
      return {};
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

function embed(body: unknown = { model: "openai/text-embed", input: "hi" }) {
  return embeddingsV2({
    request: new Request("https://gw.test/v1/embeddings", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env: {} as Env,
    apiKeyAuth: auth,
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
});
