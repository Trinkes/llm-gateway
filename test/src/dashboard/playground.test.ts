// [fork] W23: pure helpers behind the dashboard playground.
import { buildCurl } from "../../../dashboard/src/lib/playgroundCurl";
import {
  audioExtension,
  imageSrc,
} from "../../../dashboard/src/lib/playgroundFiles";
import {
  errorText,
  gatewayPath,
  isUsable,
} from "../../../dashboard/src/lib/playgroundKey";
import {
  modeInfo,
  rankModels,
  suitsMode,
} from "../../../dashboard/src/lib/playgroundModes";
import { readSse, takeSseData } from "../../../dashboard/src/lib/sseEvents";
import {
  cosineSimilarity,
  vectorNorm,
} from "../../../dashboard/src/lib/vectors";
import { describe, expect, it } from "vitest";

describe("takeSseData", () => {
  it("returns complete events and keeps the partial tail", () => {
    const { data, rest } = takeSseData(
      'data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b"',
    );
    expect(data).toEqual(['{"a":1}', "[DONE]"]);
    expect(rest).toBe('data: {"b"');
  });

  it("joins multi-line data, ignores comments and handles CRLF", () => {
    const { data, rest } = takeSseData(
      ": keepalive\r\n\r\ndata: one\r\ndata:two\r\nevent: x\r\n\r\n",
    );
    expect(data).toEqual(["one\ntwo"]);
    expect(rest).toBe("");
  });
});

describe("readSse", () => {
  it("reads payloads split across chunks and a tail without a blank line", async () => {
    const enc = new TextEncoder();
    const parts = ["data: hel", "lo\n\ndata: wor", "ld"];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        parts.forEach((p) => controller.enqueue(enc.encode(p)));
        controller.close();
      },
    });
    const seen: string[] = [];
    await readSse(body, (d) => seen.push(d));
    expect(seen).toEqual(["hello", "world"]);
  });
});

describe("rankModels", () => {
  const ids = [
    "local-m5/qwen3.8-27b",
    "local-m5-image/z-image-turbo",
    "local-m5-embed/bge-m3",
    "local-m5-tts/tiny-voca-pt-pt",
    "local-m5-stt/whisper-large-v3",
    "local-m5-decision/vllm-d3-mini",
    "openai/gpt-5",
  ];

  it.each([
    ["chat", ["local-m5/qwen3.8-27b", "openai/gpt-5"]],
    ["image", ["local-m5-image/z-image-turbo"]],
    ["image-edit", ["local-m5-image/z-image-turbo"]],
    ["embeddings", ["local-m5-embed/bge-m3"]],
    ["speech", ["local-m5-tts/tiny-voca-pt-pt"]],
    ["transcription", ["local-m5-stt/whisper-large-v3"]],
    ["decision", ["local-m5-decision/vllm-d3-mini"]],
  ] as const)("suggests the %s models first", (mode, suggested) => {
    const ranked = rankModels(mode, ids);
    expect(ranked.suggested).toEqual(suggested);
    expect([...ranked.suggested, ...ranked.others].sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("dedupes and sorts", () => {
    expect(rankModels("chat", ["b", "a", "b"])).toEqual({
      suggested: ["a", "b"],
      others: [],
    });
  });

  it("does not take every 'sd' substring for an image model", () => {
    expect(suitsMode("image", "openai/gpt-4o-sdk")).toBe(false);
    expect(suitsMode("image", "stability/sd-3.5")).toBe(true);
  });

  it("falls back to chat for an unknown mode", () => {
    expect(modeInfo("nope" as never).mode).toBe("chat");
    expect(modeInfo("speech").path).toBe("/v1/audio/speech");
  });
});

describe("vectors", () => {
  it("computes norm and cosine similarity", () => {
    expect(vectorNorm([3, 4])).toBe(5);
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it("returns null for mismatched, empty or zero vectors", () => {
    expect(cosineSimilarity([1], [1, 2])).toBeNull();
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull();
  });
});

describe("buildCurl", () => {
  it("builds a JSON request with the key left as a variable", () => {
    const curl = buildCurl("https://api.test/v1/embeddings", {
      kind: "json",
      value: { model: "m", input: ["it's"] },
    });
    expect(curl).toContain(`curl 'https://api.test/v1/embeddings'`);
    expect(curl).toContain(`-H "Authorization: Bearer $API_KEY"`);
    expect(curl).toContain(`"input": [\n    "it'\\''s"\n  ]`);
  });

  it("shortens long strings such as data URLs", () => {
    const curl = buildCurl("u", {
      kind: "json",
      value: { url: "x".repeat(500), n: 1 },
    });
    expect(curl).toContain("…(500 chars)");
    expect(curl).not.toContain("x".repeat(100));
  });

  it("builds a multipart request with file fields", () => {
    const curl = buildCurl("u", {
      kind: "form",
      fields: [
        ["model", "stt/whisper"],
        ["file", { fileName: "clip.webm" }],
      ],
    });
    expect(curl).toContain(`-F 'model=stt/whisper'`);
    expect(curl).toContain(`-F 'file=@clip.webm'`);
    expect(curl).not.toContain("Content-Type");
  });
});

describe("playground key helpers", () => {
  it("renews ten minutes before expiry", () => {
    expect(isUsable(null, 0)).toBe(false);
    const key = { key: "sk", expiresAt: 10_000, basePath: "" };
    expect(isUsable(key, 10_000 - 601)).toBe(true);
    expect(isUsable(key, 10_000 - 600)).toBe(false);
  });

  it("puts gateway paths under the tenant prefix", () => {
    expect(gatewayPath("", "/v1/models")).toBe("/v1/models");
    expect(gatewayPath("acme", "/v1/models")).toBe("/acme/v1/models");
    expect(gatewayPath("/acme/", "/v1/models")).toBe("/acme/v1/models");
  });

  it.each([
    [
      400,
      '{"error":{"message":"model is required"}}',
      "400: model is required",
    ],
    [403, '{"error":"API key is revoked"}', "403: API key is revoked"],
    [422, '{"detail":"bad state"}', "422: bad state"],
    [500, '{"message":"boom"}', "500: boom"],
    [502, "upstream down", "502: upstream down"],
    [503, "{}", "503: {}"],
    [504, "", "Request failed (504)"],
  ])("formats a %s error", (status, body, expected) => {
    expect(errorText(status, body)).toBe(expected);
  });
});

describe("playground file helpers", () => {
  it("builds image sources from b64_json or url", () => {
    expect(imageSrc({ b64_json: "AAA" })).toBe("data:image/png;base64,AAA");
    expect(imageSrc({ b64_json: "AAA" }, "JPEG")).toBe(
      "data:image/jpeg;base64,AAA",
    );
    expect(imageSrc({ b64_json: "AAA" }, "tiff")).toBe(
      "data:image/png;base64,AAA",
    );
    expect(imageSrc({ url: "https://x/y.png" })).toBe("https://x/y.png");
    expect(imageSrc({})).toBeNull();
  });

  it("names opus audio .ogg", () => {
    expect(audioExtension("opus")).toBe("ogg");
    expect(audioExtension("mp3")).toBe("mp3");
  });
});
