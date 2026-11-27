import { describe, it, expect } from "vitest";
import type { TenantSettings } from "~/src/db/tenant";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
  isModelAllowed,
  keyMayUseProvider,
} from "~/src/llm/policy";
import type { ApiKeyScopes } from "~/src/types";

describe("assertTenantActive", () => {
  it("allows active tenants", () => {
    expect(assertTenantActive({} as TenantSettings)).toBeUndefined();
  });

  it("blocks suspended tenants", () => {
    const err = assertTenantActive({ status: "suspended" } as TenantSettings);
    expect(err?.code).toBe("tenant_suspended");
    expect(err?.status).toBe(403);
  });
});

describe("assertProviderAllowed", () => {
  it("allows when scopes have no provider list", () => {
    expect(assertProviderAllowed({}, undefined, "openai")).toBeUndefined();
  });

  it("allows matching providers", () => {
    const scopes: ApiKeyScopes = { providers: ["openai", "anthropic"] };
    expect(assertProviderAllowed({}, scopes, "openai")).toBeUndefined();
  });

  it("blocks non-listed providers", () => {
    const scopes: ApiKeyScopes = { providers: ["openai"] };
    const err = assertProviderAllowed({}, scopes, "anthropic");
    expect(err?.code).toBe("provider_not_allowed");
  });
});

describe("isModelAllowed", () => {
  it("allows everything when all lists are empty", () => {
    expect(isModelAllowed([undefined], "openai", "gpt-4o")).toBe(true);
    expect(isModelAllowed([[]], "openai", "gpt-4o")).toBe(true);
  });

  it("matches bare entries against model id", () => {
    expect(
      isModelAllowed([["gpt-4o", "claude-3-5-sonnet"]], "openai", "gpt-4o"),
    ).toBe(true);
    expect(isModelAllowed([["gpt-4o"]], "anthropic", "gpt-4o")).toBe(true);
  });

  it("matches qualified entries case-insensitively", () => {
    expect(isModelAllowed([["OpenAI/gpt-4o"]], "openai", "gpt-4o")).toBe(true);
  });

  it("requires every configured list to match", () => {
    expect(isModelAllowed([["gpt-4o"], ["gpt-4o"]], "openai", "gpt-4o")).toBe(
      true,
    );
    expect(
      isModelAllowed([["gpt-4o"], ["claude-3-5-sonnet"]], "openai", "gpt-4o"),
    ).toBe(false);
  });
});

describe("assertModelAllowed", () => {
  it("blocks models outside the tenant allowlist", () => {
    const settings = { modelAllowlist: ["openai/gpt-4o"] } as TenantSettings;
    const err = assertModelAllowed(
      settings,
      undefined,
      "openai",
      "gpt-4o-mini",
    );
    expect(err?.code).toBe("model_not_allowed");
  });

  it("blocks models outside per-key scopes", () => {
    const scopes: ApiKeyScopes = { models: ["gpt-4o"] };
    const err = assertModelAllowed({}, scopes, "openai", "gpt-4o-mini");
    expect(err?.code).toBe("model_not_allowed");
  });
});

// [fork] W16: a key may use its default provider or any provider it lists.
describe("keyMayUseProvider", () => {
  it.each([
    ["an unscoped key, any provider", {}, "openai", true],
    [
      "a bound key, its provider",
      { defaultProvider: "local-m5" },
      "local-m5",
      true,
    ],
    [
      "a bound key, another provider",
      { defaultProvider: "local-m5" },
      "local-m5-image",
      false,
    ],
    [
      "a bound key, a listed provider",
      {
        defaultProvider: "local-m5",
        providers: ["local-m5", "local-m5-image"],
      },
      "Local-M5-Image",
      true,
    ],
    [
      "a bound key, an unlisted provider",
      {
        defaultProvider: "local-m5",
        providers: ["local-m5", "local-m5-image"],
      },
      "openai",
      false,
    ],
    [
      "a list without default, a listed provider",
      { providers: ["openai"] },
      "openai",
      true,
    ],
    [
      "a list without default, another provider",
      { providers: ["openai"] },
      "groq",
      false,
    ],
    [
      "an empty list with a default",
      { defaultProvider: "local-m5", providers: [] },
      "openai",
      false,
    ],
  ] as [string, ApiKeyScopes, string, boolean][])(
    "%s",
    (_, scopes, provider, expected) => {
      expect(keyMayUseProvider(scopes, provider)).toBe(expected);
    },
  );

  it("allows anything without scopes", () => {
    expect(keyMayUseProvider(undefined, "openai")).toBe(true);
  });
});
