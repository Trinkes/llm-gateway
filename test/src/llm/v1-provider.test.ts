import { afterEach, describe, expect, it, vi } from "vitest";
import { V1OpenAICompatibleClient } from "~/src/llm/v1-provider";

describe("V1OpenAICompatibleClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Cloudflare account ID and embeddings endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "cloudflare-workers-ai",
      keys: ["cf-token"],
      custom: { accountId: "a".repeat(32) },
    });

    await client.embeddings(
      JSON.stringify({ model: "@cf/baai/bge-large-en-v1.5", input: "hello" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1/embeddings`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer cf-token" }),
      }),
    );
  });

  it("fails over to the next key on retryable upstream errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "custom-openai",
      keys: ["first-key", "second-key"],
      rotationStrategy: "failover",
      custom: { baseUrl: "https://example.com/v1" },
    });

    const response = await client.chatCompletions("{}");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(
      "Bearer first-key",
    );
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe(
      "Bearer second-key",
    );
  });

  it("sends requests through an injected fetcher instead of global fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-box",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11435" },
      fetcher: binding,
    });

    await client.chatCompletions("{}");
    await client.models();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(binding.fetch).toHaveBeenCalledTimes(2);
    expect(binding.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11435/v1/chat/completions",
    );
    expect(binding.fetch.mock.calls[1][0]).toBe(
      "http://127.0.0.1:11435/v1/models",
    );
  });

  it("does not retry when first-key mode is selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "custom-openai",
      keys: ["first-key", "second-key"],
      rotationStrategy: "first",
      custom: { baseUrl: "https://example.com/v1" },
    });

    const response = await client.chatCompletions("{}");

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// [fork] W2: keyless custom providers (the local box has no API key).
describe("V1OpenAICompatibleClient without keys", () => {
  it("sends no authorization header for a keyless custom provider", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-m5",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11435" },
      fetcher: binding,
    });

    await client.chatCompletions("{}");

    const headers = binding.fetch.mock.calls[0][1].headers;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain(
      "authorization",
    );
  });
});

// [fork] W1: a vpc client only ever calls the upstream's /v1/ API.
describe("V1OpenAICompatibleClient over a vpc binding", () => {
  it("refuses a request whose final URL is outside the /v1/ API", async () => {
    const binding = { fetch: vi.fn() };
    const client = new V1OpenAICompatibleClient({
      provider: "local-m5",
      keys: [],
      custom: {
        baseUrl: "http://127.0.0.1:11435",
        modelsPath: "/admin/shutdown",
      },
      fetcher: binding,
    });

    await expect(client.models()).rejects.toThrow(/not allowed/);
    expect(binding.fetch).not.toHaveBeenCalled();
  });
});

// [fork] W2: with zero keys there is nothing to fail over to.
describe("V1OpenAICompatibleClient error responses without keys", () => {
  it("returns a readable upstream error body when no keys are configured", async () => {
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(new Response("upstream exploded", { status: 500 })),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-m5",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11435" },
      fetcher: binding,
    });

    const response = await client.chatCompletions("{}");

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("upstream exploded");
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });
});

// [fork] W15: image generations through the same client.
describe("V1OpenAICompatibleClient.imageGenerations", () => {
  afterEach(() => vi.unstubAllGlobals());

  function box(custom: Record<string, string> = {}) {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-box",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11436", ...custom },
      fetcher: binding,
    });
    return { binding, client };
  }

  it("posts to the custom images path through the fetcher", async () => {
    const { binding, client } = box();
    const body = JSON.stringify({ model: "m", prompt: "a cat" });

    const res = await client.imageGenerations(body);

    expect(res.status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = binding.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11436/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(init.headers.authorization).toBeUndefined();
  });

  it("honours an explicit custom.imagesPath", async () => {
    const { binding, client } = box({ imagesPath: "/v1/images/generations" });

    await client.imageGenerations("{}");

    expect(binding.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11436/v1/images/generations",
    );
  });

  it("refuses an images path outside the allowed vpc endpoints", async () => {
    const { binding, client } = box({ imagesPath: "/other" });

    await expect(client.imageGenerations("{}")).rejects.toThrow(/not allowed/);
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("passes the abort signal to the upstream fetch", async () => {
    const { binding, client } = box();
    const controller = new AbortController();

    await client.imageGenerations("{}", { signal: controller.signal });

    expect(binding.fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("uses /images/generations under a registry provider's base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "openai",
      keys: ["sk-test"],
    });

    await client.imageGenerations("{}");

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/images\/generations$/);
    expect(fetchMock.mock.calls[0][0]).not.toMatch(/\/v1\/v1\//);
  });
});

// [fork] W20: any request body (multipart, JSON) to a fixed upstream path.
describe("V1OpenAICompatibleClient.post", () => {
  function box() {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-box",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11438" },
      fetcher: binding,
    });
    return { binding, client };
  }

  it("sends a form without its own content type so fetch adds the boundary", async () => {
    const { binding, client } = box();
    const form = new FormData();
    form.set("model", "m");

    await client.post("/v1/audio/transcriptions", form, { contentType: null });

    const [url, init] = binding.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11438/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect(init.headers["content-type"]).toBeUndefined();
  });

  it("sends a JSON body as application/json by default", async () => {
    const { binding, client } = box();

    await client.post("/v1/audio/speech", '{"input":"x"}');

    const init = binding.fetch.mock.calls[0][1];
    expect(init.body).toBe('{"input":"x"}');
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("passes the abort signal to the upstream fetch", async () => {
    const { binding, client } = box();
    const controller = new AbortController();

    await client.post("/v1/systemone", "{}", { signal: controller.signal });

    expect(binding.fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("refuses a path outside the allowed vpc endpoints", async () => {
    const { binding, client } = box();

    await expect(client.post("/v1/other", "{}")).rejects.toThrow(/not allowed/);
    expect(binding.fetch).not.toHaveBeenCalled();
  });
});
