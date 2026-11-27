// [fork] W17
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  imageCount,
  kindInfo,
  TOKEN_ROWS_SQL,
} from "~/src/metrics/request-kinds";

describe("kindInfo", () => {
  it("counts chat and embedding in tokens", () => {
    expect(kindInfo("chat")).toEqual({
      kind: "chat",
      unit: "tokens",
      label: "Chat",
    });
    expect(kindInfo("embedding")).toEqual({
      kind: "embedding",
      unit: "tokens",
      label: "Embedding",
    });
  });

  it("counts image in images", () => {
    expect(kindInfo("image")).toEqual({
      kind: "image",
      unit: "images",
      label: "Image",
    });
  });

  // [fork] W20
  it.each([
    ["transcription", "Transcription"],
    ["speech", "Speech"],
    ["decision", "Decision"],
  ])("labels %s with no unit (shown as duration)", (kind, label) => {
    expect(kindInfo(kind)).toEqual({ kind, unit: null, label });
  });

  it("gives an unknown kind no unit and its own name as label", () => {
    expect(kindInfo("audio")).toEqual({
      kind: "audio",
      unit: null,
      label: "audio",
    });
    expect(kindInfo("constructor")).toEqual({
      kind: "constructor",
      unit: null,
      label: "constructor",
    });
  });
});

describe("imageCount", () => {
  it.each([
    [undefined, 1],
    [4, 4],
    [1, 1],
    [10, 10],
    [0, 1],
    [11, 1],
    [2.5, 1],
    ["2", 1],
    [null, 1],
  ])("%j -> %i", (input, expected) => {
    expect(imageCount(input)).toBe(expected);
  });
});

describe("TOKEN_ROWS_SQL", () => {
  it("prefixes columns with the alias when given", () => {
    expect(TOKEN_ROWS_SQL("m")).toContain("COALESCE(m.tokens_input, 0) > 0");
    expect(TOKEN_ROWS_SQL()).toContain("COALESCE(tokens_input, 0) > 0");
    expect(TOKEN_ROWS_SQL()).not.toContain(".");
  });

  it("matches rows with any token count and skips the rest", async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS kind_rows (id INTEGER PRIMARY KEY, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)",
    );
    await env.DB.exec("DELETE FROM kind_rows");
    await env.DB.prepare(
      `INSERT INTO kind_rows VALUES
        (1, NULL, NULL, NULL, NULL),
        (2, 0, 0, 0, 0),
        (3, 5, NULL, NULL, NULL),
        (4, NULL, 5, NULL, NULL),
        (5, NULL, NULL, 5, NULL),
        (6, NULL, NULL, NULL, 5)`,
    ).run();
    const { results } = await env.DB.prepare(
      `SELECT r.id FROM kind_rows r WHERE ${TOKEN_ROWS_SQL("r")} ORDER BY r.id`,
    ).all<{ id: number }>();
    expect(results.map((r) => r.id)).toEqual([3, 4, 5, 6]);
  });
});
