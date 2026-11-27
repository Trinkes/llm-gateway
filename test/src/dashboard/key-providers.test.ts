// [fork] W16: provider selection for API keys (several providers per key).
import {
  applyProviderSelection,
  initialProviderSelection,
  keyProviderIds,
  toggleProvider,
} from "../../../dashboard/src/lib/keyProviders";
import { describe, expect, it } from "vitest";

describe("initialProviderSelection", () => {
  it("starts empty for an unscoped key", () => {
    expect(initialProviderSelection({})).toEqual({
      selected: [],
      defaultProvider: "",
    });
  });

  it("selects the bound provider of a single-provider key", () => {
    expect(initialProviderSelection({ defaultProvider: "local-m5" })).toEqual({
      selected: ["local-m5"],
      defaultProvider: "local-m5",
    });
  });

  it("selects every listed provider and keeps the default", () => {
    expect(
      initialProviderSelection({
        providers: ["local-m5", "local-m5-image"],
        defaultProvider: "local-m5",
      }),
    ).toEqual({
      selected: ["local-m5", "local-m5-image"],
      defaultProvider: "local-m5",
    });
  });
});

describe("toggleProvider", () => {
  it("adds and removes a provider", () => {
    expect(toggleProvider(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleProvider(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("applyProviderSelection", () => {
  const base = { spendCapUsd: 5, providers: ["x"], defaultProvider: "x" };

  it("clears both scopes when nothing is selected", () => {
    expect(applyProviderSelection(base, [], "")).toEqual({ spendCapUsd: 5 });
  });

  it("binds a single provider without a provider list", () => {
    expect(applyProviderSelection(base, ["local-m5"], "")).toEqual({
      spendCapUsd: 5,
      defaultProvider: "local-m5",
    });
  });

  it("stores several providers with the chosen default", () => {
    expect(
      applyProviderSelection(
        base,
        ["local-m5", "local-m5-image"],
        "local-m5-image",
      ),
    ).toEqual({
      spendCapUsd: 5,
      providers: ["local-m5", "local-m5-image"],
      defaultProvider: "local-m5-image",
    });
  });

  it("falls back to the first selected provider for a stale default", () => {
    expect(
      applyProviderSelection({}, ["local-m5", "local-m5-image"], "gone"),
    ).toEqual({
      providers: ["local-m5", "local-m5-image"],
      defaultProvider: "local-m5",
    });
  });
});

describe("keyProviderIds", () => {
  it("lists the providers a key may use", () => {
    expect(keyProviderIds({})).toEqual([]);
    expect(keyProviderIds({ defaultProvider: "a" })).toEqual(["a"]);
    expect(
      keyProviderIds({ providers: ["a", "b"], defaultProvider: "a" }),
    ).toEqual(["a", "b"]);
  });
});
