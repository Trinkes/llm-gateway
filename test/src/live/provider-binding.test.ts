// [fork] W12: which providers reach the box, by organization.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  providerVpcBinding,
  toVpcProviders,
  vpcProviders,
  vpcProvidersStatement,
} from "~/src/live/provider-binding";

const e = { ...env, VPC_BINDINGS: "HALOGEN:org_a" } as unknown as Env;

async function config(org: string, provider: string, settings: object) {
  await env.DB.prepare(
    "INSERT INTO provider_configs (id, organization_id, provider, config) VALUES (?, ?, ?, ?)",
  )
    .bind(
      `${org}-${provider}`,
      org,
      provider,
      JSON.stringify({ keys: [], settings }),
    )
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
  await config("org_a", "box", { transport: "vpc", vpcBinding: "HALOGEN" });
  await config("org_b", "box", { transport: "vpc", vpcBinding: "HALOGEN" });
  await config("org_a", "openai", { baseUrl: "https://api.openai.com" });
  await config("org_a", "nobinding", { transport: "vpc" });
});

describe("vpcProviders", () => {
  it("finds vpc providers allowed by VPC_BINDINGS", async () => {
    expect(await vpcProviders(e)).toEqual([
      { organizationId: "org_a", provider: "box", binding: "HALOGEN" },
    ]);
  });

  it("can be limited to one organization", async () => {
    expect(await vpcProviders(e, "org_b")).toEqual([]);
    expect(await vpcProviders(e, "org_a")).toHaveLength(1);
  });
});

describe("vpcProvidersStatement + toVpcProviders", () => {
  it("drops rows the allowlist does not allow for that org", () => {
    const rows = [
      { organization_id: "org_a", provider: "box", binding: "HALOGEN" },
      { organization_id: "org_b", provider: "box", binding: "HALOGEN" },
      { organization_id: "org_a", provider: "nobinding", binding: null },
    ];
    expect(toVpcProviders(e, rows)).toEqual([
      { organizationId: "org_a", provider: "box", binding: "HALOGEN" },
    ]);
  });

  it("matches vpcProviders when run in a batch", async () => {
    const [all, one] = await env.DB.batch([
      vpcProvidersStatement(e),
      vpcProvidersStatement(e, "org_a"),
    ]);
    expect(toVpcProviders(e, all.results)).toEqual(await vpcProviders(e));
    expect(toVpcProviders(e, one.results)).toEqual(
      await vpcProviders(e, "org_a"),
    );
  });
});

describe("providerVpcBinding", () => {
  it("returns the binding or null", async () => {
    expect(await providerVpcBinding(e, "org_a", "box")).toBe("HALOGEN");
    expect(await providerVpcBinding(e, "org_b", "box")).toBeNull();
    expect(await providerVpcBinding(e, "org_a", "openai")).toBeNull();
  });
});
