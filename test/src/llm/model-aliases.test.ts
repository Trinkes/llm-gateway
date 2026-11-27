// [fork] W18: provider-level model aliases (public name → upstream model id).
import { describe, expect, it } from "vitest";
import {
  aliasModelList,
  upstreamModelId,
  validateModelAliases,
} from "~/src/llm/model-aliases";

const settings = { modelAliases: { "z-image-turbo": "sd-cpp-local" } };

describe("upstreamModelId", () => {
  it("maps an alias to its upstream id", () => {
    expect(upstreamModelId(settings, "z-image-turbo")).toBe("sd-cpp-local");
  });

  it("passes other ids through", () => {
    expect(upstreamModelId(settings, "other")).toBe("other");
    expect(upstreamModelId(undefined, "other")).toBe("other");
    expect(upstreamModelId({ modelAliases: "bad" }, "other")).toBe("other");
  });
});

describe("aliasModelList", () => {
  it("lists the alias instead of the upstream id", () => {
    const list = [
      { id: "sd-cpp-local", api: "x" },
      { id: "plain", api: "x" },
    ];
    expect(aliasModelList(settings, list)).toEqual([
      { id: "z-image-turbo", api: "x" },
      { id: "plain", api: "x" },
    ]);
  });

  it("lists every alias of one upstream id", () => {
    const two = { modelAliases: { a: "up", b: "up" } };
    expect(aliasModelList(two, [{ id: "up" }]).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("leaves the list alone without aliases", () => {
    const list = [{ id: "sd-cpp-local" }];
    expect(aliasModelList({}, list)).toBe(list);
  });
});

describe("validateModelAliases", () => {
  it("accepts a string-to-string map and trims it", () => {
    expect(
      validateModelAliases({ " z-image-turbo ": " sd-cpp-local " }),
    ).toEqual({ "z-image-turbo": "sd-cpp-local" });
  });

  it.each([
    ["an array", ["a"]],
    ["null", null],
    ["a string", "a=b"],
    ["a non-string target", { a: 1 }],
    ["an empty alias", { " ": "up" }],
    ["an empty target", { a: " " }],
    ["an alias with a slash", { "p/a": "up" }],
    [
      "too many entries",
      Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, "up"])),
    ],
  ])("rejects %s", (_, value) => {
    expect(() => validateModelAliases(value)).toThrow("settings.modelAliases");
  });
});
