import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppBindings } from "~/src/app";
import { apiKeyAuthMiddleware } from "~/src/middlewares/auth-required";
import { nowSeconds, sha256Hex } from "~/src/utils/crypto";

const ORG = "org_keyauth";

function buildApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/*", apiKeyAuthMiddleware);
  app.get("/v1/ping", (c) => c.json({ keyId: c.get("apiKeyAuth")!.keyId }));
  return app;
}

async function seedKey(
  id: string,
  secret: string,
  expiresAt: number | null,
  status = "active",
) {
  await env.DB.prepare(
    `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, 'user_1', ?, ?, ?)`,
  )
    .bind(
      id,
      ORG,
      id,
      await sha256Hex(secret),
      secret.slice(0, 8),
      nowSeconds() - 3600,
      expiresAt,
      status,
    )
    .run();
}

async function call(secret: string) {
  const res = await buildApp().request(
    "/v1/ping",
    { headers: { authorization: `Bearer ${secret}` } },
    env as never,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, string>,
  };
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, spend_disabled_until INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}');",
  );
  const now = nowSeconds();
  await seedKey("key_live", "sk_live_valid", now + 3600);
  await seedKey("key_never", "sk_live_never", null);
  await seedKey("key_expired", "sk_live_expired", now - 1);
  await seedKey("key_revoked", "sk_live_revoked", null, "revoked");
});

describe("apiKeyAuthMiddleware — expiry", () => {
  it("accepts a key before its expiry and a key with none", async () => {
    expect(await call("sk_live_valid")).toEqual({
      status: 200,
      body: { keyId: "key_live" },
    });
    expect((await call("sk_live_never")).status).toBe(200);
  });

  it("refuses an expired key with 403", async () => {
    expect(await call("sk_live_expired")).toEqual({
      status: 403,
      body: { error: "API key has expired" },
    });
  });

  it("refuses a revoked key before checking expiry", async () => {
    expect(await call("sk_live_revoked")).toEqual({
      status: 403,
      body: { error: "API key is revoked" },
    });
  });
});
