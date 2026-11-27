// [fork] W20: image edits, transcriptions, speech and systemone over a vpc
// provider. The shared flow (policy, rate limit, heartbeat) is covered by
// image_generations_v2.test.ts; these tests cover what each route adds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { checkRateLimits, settleTokenUsage } from "~/src/llm/rate-limit";
import { getModelPricing } from "~/src/metrics/cost-tracker";
import { recordChatRequest } from "~/src/metrics/request-logger";
import { maybeDisableAfterSpend } from "~/src/metrics/spend-guard";
import {
  audioSpeechV2,
  audioTranscriptionsV2,
  imageEditsV2,
  systemoneV2,
} from "~/src/requests/vpc_passthrough_v2";
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
  settleTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/src/metrics/spend-guard", () => ({
  maybeDisableAfterSpend: vi.fn().mockResolvedValue(undefined),
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
const mockSettle = vi.mocked(settleTokenUsage);
const mockMaybeDisable = vi.mocked(maybeDisableAfterSpend);

const auth = {
  keyId: "key_1",
  organizationId: "org_1",
  scopes: {},
  spendDisabledUntil: null,
} as unknown as ApiKeyAuth;

function box(settings: Record<string, unknown> = {}): DecryptedProviderConfig {
  return {
    id: "pcfg_box",
    provider: "local-box",
    name: "local-box",
    enabled: true,
    keys: [],
    settings: {
      baseUrl: "http://127.0.0.1:11440",
      transport: "vpc",
      vpcBinding: "BOX",
      ...settings,
    },
    updatedAt: 1,
  };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

function binding(response: Response = new Response('{"ok":true}')) {
  return { fetch: vi.fn().mockResolvedValue(response) };
}

function envWith(fetcher: { fetch: unknown }) {
  return { VPC_BINDINGS: "BOX:org_1", BOX: fetcher } as unknown as Env;
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://gw.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function formRequest(path: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(`https://gw.test${path}`, { method: "POST", body: form });
}

const png = () =>
  new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
const wav = () =>
  new File([new Uint8Array([82, 73, 70, 70])], "a.wav", { type: "audio/wav" });

async function settled() {
  await Promise.all(pending);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimits.mockResolvedValue({ allowed: true });
  mockGetModelPricing.mockResolvedValue({
    provider: "local-box",
    model: "klein",
    inputPer1m: 0,
    outputPer1m: 40,
    cacheReadPer1m: 0,
    cacheWritePer1m: 0,
  });
  tenant.settings = {};
  pending.length = 0;
});

describe("audioSpeechV2", () => {
  beforeEach(() => mockGetProviderConfig.mockResolvedValue(box()));

  it("forwards JSON with the upstream model id and returns the audio", async () => {
    const fetcher = binding(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      }),
    );
    mockGetProviderConfig.mockResolvedValue(
      box({ modelAliases: { voice: "tts-1" } }),
    );

    const res = await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", {
        model: "local-box/voice",
        input: "Bom dia.",
        voice: "F3",
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([82, 73, 70, 70]),
    );
    const [url, init] = fetcher.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11440/v1/audio/speech");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      model: "tts-1",
      input: "Bom dia.",
      voice: "F3",
    });
  });

  it("records a speech row at cost 0 without a price lookup", async () => {
    await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", {
        model: "local-box/voice",
        input: "Olá.",
      }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    await settled();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, attempt, outcome] = mockRecord.mock.calls[0];
    expect(attempt).toMatchObject({
      method: "speech",
      provider: "local-box",
      model: "voice",
    });
    expect(outcome).toMatchObject({ statusCode: 200, costUsd: 0, units: null });
    expect(mockGetModelPricing).not.toHaveBeenCalled();
  });

  it("passes an upstream 400 through and records it", async () => {
    const fetcher = binding(
      new Response('{"error":"nothing to read"}', { status: 400 }),
    );

    const res = await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", {
        model: "local-box/voice",
        input: "🙂",
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    await settled();

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("nothing to read");
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 400 });
  });

  it("requires input", async () => {
    const fetcher = binding();
    const res = await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", { model: "local-box/voice" }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const res = await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", "{nope"),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a public provider", async () => {
    mockGetProviderConfig.mockResolvedValue(
      box({ transport: "public", baseUrl: "https://api.example.com" }),
    );
    const res = await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", {
        model: "local-box/voice",
        input: "x",
      }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "speech requests are only served by vpc providers",
    );
  });

  it("returns 502 when the upstream call throws", async () => {
    const fetcher = {
      fetch: vi.fn().mockRejectedValue(new Error("tunnel down")),
    };
    const res = await audioSpeechV2({
      request: jsonRequest("/v1/audio/speech", {
        model: "local-box/voice",
        input: "x",
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    await settled();
    expect(res.status).toBe(502);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ statusCode: 502 });
  });
});

describe("systemoneV2", () => {
  beforeEach(() =>
    mockGetProviderConfig.mockResolvedValue(
      box({ baseUrl: "http://127.0.0.1:11437" }),
    ),
  );

  it("forwards the body without the gateway model and records a decision row", async () => {
    const fetcher = binding(
      new Response('{"answers":{"q":{"choice":"yes"}}}', {
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await systemoneV2({
      request: jsonRequest("/v1/systemone", {
        model: "local-box/decider",
        state: "Manda um email.",
        questions: { q: { type: "choice" } },
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    await settled();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answers: { q: { choice: "yes" } } });
    const [url, init] = fetcher.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11437/v1/systemone");
    expect(JSON.parse(init.body)).toEqual({
      state: "Manda um email.",
      questions: { q: { type: "choice" } },
    });
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ method: "decision" });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ costUsd: 0 });
  });

  it("uses the key's default provider for a bare model", async () => {
    const fetcher = binding();
    await systemoneV2({
      request: jsonRequest("/v1/systemone", { model: "decider", state: "x" }),
      env: envWith(fetcher),
      apiKeyAuth: {
        ...auth,
        scopes: { defaultProvider: "local-box" },
      } as unknown as ApiKeyAuth,
      ctx,
    });
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it("requires a model", async () => {
    const res = await systemoneV2({
      request: jsonRequest("/v1/systemone", { state: "x" }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
  });
});

describe("audioTranscriptionsV2", () => {
  beforeEach(() =>
    mockGetProviderConfig.mockResolvedValue(
      box({ baseUrl: "http://127.0.0.1:11438" }),
    ),
  );

  it("forwards the form with the upstream model id and records a transcription row", async () => {
    const fetcher = binding(
      new Response('{"text":"Bom dia."}', {
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await audioTranscriptionsV2({
      request: formRequest("/v1/audio/transcriptions", {
        model: "local-box/asr",
        file: wav(),
        language: "pt",
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    await settled();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Bom dia." });
    const [url, init] = fetcher.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11438/v1/audio/transcriptions");
    expect(init.headers["content-type"]).toBeUndefined();
    const sent = init.body as FormData;
    expect(sent.get("model")).toBe("asr");
    expect(sent.get("language")).toBe("pt");
    expect((sent.get("file") as File).name).toBe("a.wav");
    expect(mockRecord.mock.calls[0][1]).toMatchObject({
      method: "transcription",
    });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ costUsd: 0 });
  });

  it("sends no heartbeat spaces before a text transcript", async () => {
    let answer: (r: Response) => void = () => {};
    const fetcher = {
      fetch: vi.fn(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      ),
    };
    const pendingRes = audioTranscriptionsV2({
      request: formRequest("/v1/audio/transcriptions", {
        model: "local-box/asr",
        file: wav(),
        response_format: "text",
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
      timing: { graceMs: 1, heartbeatMs: 1000 },
    });
    await new Promise((r) => setTimeout(r, 20));
    answer(
      new Response("Bom dia.", { headers: { "content-type": "text/plain" } }),
    );
    const res = await pendingRes;
    const body = await res.text();
    await settled();

    expect(body).toBe("Bom dia.");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("requires a file", async () => {
    const fetcher = binding();
    const res = await audioTranscriptionsV2({
      request: formRequest("/v1/audio/transcriptions", {
        model: "local-box/asr",
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("refuses a body that is not multipart", async () => {
    const res = await audioTranscriptionsV2({
      request: jsonRequest("/v1/audio/transcriptions", {
        model: "local-box/asr",
      }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
  });
});

describe("audioTranscriptionsV2 pricing", () => {
  // [fork] W21: priced from the reply's `usage` tokens, not stored as tokens.
  const reply =
    '{"text":"Olá, bom dia.","usage":{"type":"tokens","input_tokens":69,"output_tokens":29,"total_tokens":98,"input_tokens_details":{"cached_tokens":14}}}';
  const expectedCost = (69 * 3 + 29 * 5) / 1_000_000;

  beforeEach(() => {
    mockGetProviderConfig.mockResolvedValue(box());
    mockGetModelPricing.mockResolvedValue({
      provider: "local-box",
      model: "*",
      inputPer1m: 3,
      outputPer1m: 5,
      cacheReadPer1m: 0,
      cacheWritePer1m: 0,
    });
    tenant.settings = { rateLimit: { tokensPerMinute: 1000 } };
  });

  function transcribe(
    fetcher: { fetch: unknown },
    timing?: { graceMs: number; heartbeatMs: number },
  ) {
    return audioTranscriptionsV2({
      request: formRequest("/v1/audio/transcriptions", {
        model: "local-box/asr",
        file: wav(),
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
      ...(timing ? { timing } : {}),
    });
  }

  function slowFetcher() {
    let answer: (r: Response) => void = () => {};
    const fetcher = {
      fetch: vi.fn(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      ),
    };
    return { fetcher, answer: (r: Response) => answer(r) };
  }

  it("prices a direct reply from its usage and passes it through byte for byte", async () => {
    const fetcher = binding(
      new Response(reply, { headers: { "content-type": "application/json" } }),
    );

    const res = await transcribe(fetcher);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await settled();

    expect(res.status).toBe(200);
    expect(bytes).toEqual(new TextEncoder().encode(reply));
    expect(mockGetModelPricing).toHaveBeenCalledWith(
      expect.anything(),
      "local-box",
      "asr",
    );
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const outcome = mockRecord.mock.calls[0][2];
    expect(outcome.statusCode).toBe(200);
    expect(outcome.costUsd).toBeCloseTo(expectedCost, 12);
    expect(outcome.units).toBeNull();
  });

  it("stores no token counts on a priced transcription row", async () => {
    await transcribe(binding(new Response(reply)));
    await settled();

    const outcome = mockRecord.mock.calls[0][2];
    expect(outcome.usage ?? null).toBeNull();
    expect(mockRecord.mock.calls[0][1]).toMatchObject({
      method: "transcription",
    });
  });

  it("settles the token bucket and re-checks spend caps after a priced reply", async () => {
    await transcribe(binding(new Response(reply)));
    await settled();

    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle.mock.calls[0][1]).toMatchObject({
      organizationId: "org_1",
      actualTokens: 98,
    });
    expect(mockMaybeDisable).toHaveBeenCalledTimes(1);
  });

  it("does not re-check spend caps when the price is 0", async () => {
    mockGetModelPricing.mockResolvedValue({
      provider: "local-box",
      model: "*",
      inputPer1m: 0,
      outputPer1m: 0,
      cacheReadPer1m: 0,
      cacheWritePer1m: 0,
    });
    await transcribe(binding(new Response(reply)));
    await settled();

    expect(mockRecord.mock.calls[0][2]).toMatchObject({ costUsd: 0 });
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockMaybeDisable).not.toHaveBeenCalled();
  });

  it("prices a heartbeat reply from its usage and passes it through after the spaces", async () => {
    const { fetcher, answer } = slowFetcher();
    const res = await transcribe(fetcher, { graceMs: 1, heartbeatMs: 1000 });
    answer(
      new Response(reply, { headers: { "content-type": "application/json" } }),
    );
    const body = await res.text();
    await settled();

    expect(res.status).toBe(200);
    expect(body.startsWith(" ")).toBe(true);
    expect(body.trimStart()).toBe(reply);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2].costUsd).toBeCloseTo(expectedCost, 12);
    expect(mockRecord.mock.calls[0][2].usage ?? null).toBeNull();
    expect(mockSettle.mock.calls[0][1]).toMatchObject({ actualTokens: 98 });
    expect(mockMaybeDisable).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no usage", '{"text":"Bom dia."}'],
    ["usage that is not an object", '{"text":"x","usage":"lots"}'],
    [
      "non-numeric tokens",
      '{"text":"x","usage":{"input_tokens":"69","output_tokens":29}}',
    ],
    [
      "negative tokens",
      '{"text":"x","usage":{"input_tokens":-5,"output_tokens":29}}',
    ],
    ["duration usage", '{"text":"x","usage":{"type":"duration","seconds":4}}'],
    ["a reply that is not JSON", "Bom dia."],
  ])("records %s at cost 0", async (_label, body) => {
    const res = await transcribe(binding(new Response(body)));
    expect(await res.text()).toBe(body);
    await settled();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 200,
      costUsd: 0,
    });
    expect(mockSettle).not.toHaveBeenCalled();
    expect(mockMaybeDisable).not.toHaveBeenCalled();
  });

  it("records an upstream error at cost 0 without a price lookup", async () => {
    const res = await transcribe(
      binding(new Response('{"error":"bad format"}', { status: 400 })),
    );
    await settled();

    expect(res.status).toBe(400);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 400,
      costUsd: 0,
    });
    expect(mockGetModelPricing).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("records an upstream error after the heartbeat at cost 0", async () => {
    const { fetcher, answer } = slowFetcher();
    const res = await transcribe(fetcher, { graceMs: 1, heartbeatMs: 1000 });
    answer(new Response("boom", { status: 500 }));
    await res.text();
    await settled();

    expect(mockRecord.mock.calls[0][2]).toMatchObject({
      statusCode: 500,
      costUsd: 0,
    });
    expect(mockGetModelPricing).not.toHaveBeenCalled();
  });
});

describe("imageEditsV2", () => {
  beforeEach(() =>
    mockGetProviderConfig.mockResolvedValue(
      box({ baseUrl: "http://127.0.0.1:11436", imageEdits: true }),
    ),
  );

  it("forwards every reference image and prices the edit like a generation", async () => {
    const fetcher = binding(
      new Response('{"data":[{"b64_json":"AAAA"}]}', {
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await imageEditsV2({
      request: (() => {
        const form = new FormData();
        form.append("model", "local-box/klein");
        form.append("prompt", "replace the cup with a vase");
        form.append("image[]", png());
        form.append("image[]", png());
        form.append("size", "1024x1024");
        form.append("quality", "low");
        form.append("n", "2");
        return new Request("https://gw.test/v1/images/edits", {
          method: "POST",
          body: form,
        });
      })(),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    await settled();

    expect(res.status).toBe(200);
    const [url, init] = fetcher.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11436/v1/images/edits");
    const sent = init.body as FormData;
    expect(sent.get("model")).toBe("klein");
    expect(sent.getAll("image[]")).toHaveLength(2);
    expect(sent.get("n")).toBe("2");
    const [, attempt, outcome] = mockRecord.mock.calls[0];
    expect(attempt).toMatchObject({ method: "image", model: "klein" });
    // 2 low-quality 1024x1024 images = 544 output tokens at $40 / 1M.
    expect(outcome).toMatchObject({ statusCode: 200, units: 2 });
    expect(outcome.costUsd).toBeCloseTo((544 * 40) / 1e6, 10);
  });

  it("refuses a provider without image edits enabled", async () => {
    mockGetProviderConfig.mockResolvedValue(
      box({ baseUrl: "http://127.0.0.1:11436" }),
    );
    const fetcher = binding();

    const res = await imageEditsV2({
      request: formRequest("/v1/images/edits", {
        model: "local-box/klein",
        prompt: "x",
        image: png(),
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not serve image edits");
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("requires a reference image", async () => {
    const res = await imageEditsV2({
      request: formRequest("/v1/images/edits", {
        model: "local-box/klein",
        prompt: "x",
      }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
  });

  it("requires a prompt", async () => {
    const res = await imageEditsV2({
      request: formRequest("/v1/images/edits", {
        model: "local-box/klein",
        image: png(),
      }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a size it cannot price", async () => {
    const res = await imageEditsV2({
      request: formRequest("/v1/images/edits", {
        model: "local-box/klein",
        prompt: "x",
        image: png(),
        size: "big",
      }),
      env: envWith(binding()),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
  });

  it.each(["size", "quality", "n", "model", "prompt"])(
    "refuses a repeated %s field so the upstream gets what was priced",
    async (field) => {
      const fetcher = binding();
      const form = new FormData();
      form.append("model", "local-box/klein");
      form.append("prompt", "x");
      form.append("image", png());
      form.append("size", "256x256");
      form.append("quality", "low");
      form.append("n", "1");
      form.append(field, field === "size" ? "4096x4096" : "2");

      const res = await imageEditsV2({
        request: new Request("https://gw.test/v1/images/edits", {
          method: "POST",
          body: form,
        }),
        env: envWith(fetcher),
        apiKeyAuth: auth,
        ctx,
      });

      expect(res.status).toBe(400);
      expect(fetcher.fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses a file where a priced field is expected", async () => {
    const fetcher = binding();
    const res = await imageEditsV2({
      request: formRequest("/v1/images/edits", {
        model: "local-box/klein",
        prompt: "x",
        image: png(),
        size: png(),
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("refuses a repeated model on a transcription", async () => {
    const fetcher = binding();
    const form = new FormData();
    form.append("model", "local-box/asr");
    form.append("model", "other/asr");
    form.append("file", wav());
    const res = await audioTranscriptionsV2({
      request: new Request("https://gw.test/v1/audio/transcriptions", {
        method: "POST",
        body: form,
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
    });
    expect(res.status).toBe(400);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("sends spaces then the image when the upstream is slow", async () => {
    let answer: (r: Response) => void = () => {};
    const fetcher = {
      fetch: vi.fn(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      ),
    };
    const res = await imageEditsV2({
      request: formRequest("/v1/images/edits", {
        model: "local-box/klein",
        prompt: "x",
        image: png(),
      }),
      env: envWith(fetcher),
      apiKeyAuth: auth,
      ctx,
      timing: { graceMs: 1, heartbeatMs: 1000 },
    });
    answer(new Response('{"data":[]}'));
    const body = await res.text();
    await settled();

    expect(res.status).toBe(200);
    expect(body.startsWith(" ")).toBe(true);
    expect(body.trim()).toBe('{"data":[]}');
  });
});
