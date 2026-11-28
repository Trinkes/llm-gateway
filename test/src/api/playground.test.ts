// [fork] W23: the playground's self-issued API key.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keysRouter } from "~/src/api/keys";
import { PLAYGROUND_KEY_TTL_S, playgroundRouter } from "~/src/api/playground";
import { PLAYGROUND_KEY_NAME } from "~/src/api/playground-key-name";
import type { AppBindings } from "~/src/app";
import type { SessionAuth } from "~/src/types";
import { nowSeconds, sha256Hex } from "~/src/utils/crypto";

function sessionFor(userId: string, organizationId = "org_pg"): SessionAuth {
  return {
    userId,
    sessionId: `sess_${userId}`,
    organizationId,
    role: "admin",
    email: `${userId}@acme.test`,
    expiresAt: 9999999999,
  };
}

function buildApp(session: SessionAuth): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/api/playground", playgroundRouter);
  app.route("/api/keys", keysRouter);
  return app;
}

async function issue(session: SessionAuth) {
  const res = await buildApp(session).request(
    "/api/playground/key",
    { method: "POST" },
    env as never,
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      id: string;
      key: string;
      keyPrefix: string;
      expiresAt: number;
      basePath: string;
    },
  };
}

type Row = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_by: string;
  expires_at: number;
  status: string;
  scopes: string;
};

async function playgroundRows(orgId = "org_pg"): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, key_hash, key_prefix, created_by, expires_at, status, scopes FROM api_keys WHERE organization_id = ? AND name = ?",
  )
    .bind(orgId, PLAYGROUND_KEY_NAME)
    .all<Row>();
  return results;
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, is_root_tenant INTEGER NOT NULL DEFAULT 0, system_prefix TEXT, custom_prefix TEXT);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}');",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM api_keys");
  await env.DB.exec("DELETE FROM organizations");
  await env.DB.exec("DELETE FROM audit_logs");
});

describe("POST /api/playground/key", () => {
  it("creates an unscoped, expiring key on first use", async () => {
    const before = nowSeconds();
    const { status, body } = await issue(sessionFor("user_a"));
    expect(status).toBe(200);
    expect(body.key).toMatch(/^sk_live_[0-9a-f]{64}$/);
    expect(body.keyPrefix).toBe(body.key.slice(0, 8));
    expect(body.expiresAt).toBeGreaterThanOrEqual(
      before + PLAYGROUND_KEY_TTL_S,
    );
    expect(body.basePath).toBe("");

    const rows = await playgroundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      created_by: "user_a",
      key_prefix: body.keyPrefix,
      status: "active",
      scopes: "{}",
      expires_at: body.expiresAt,
    });
    expect(rows[0].key_hash).toBe(await sha256Hex(body.key));

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE resource_id = ?",
    )
      .bind(body.id)
      .first<{ action: string }>();
    expect(audit?.action).toBe("create");
  });

  it("replaces the secret of the same row on later calls", async () => {
    const first = await issue(sessionFor("user_a"));
    await env.DB.prepare("UPDATE api_keys SET status = 'revoked'").run();
    const second = await issue(sessionFor("user_a"));

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.key).not.toBe(first.body.key);
    const rows = await playgroundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].key_hash).toBe(await sha256Hex(second.body.key));

    const { results } = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE resource_id = ? ORDER BY timestamp",
    )
      .bind(first.body.id)
      .all<{ action: string }>();
    expect(results.map((r) => r.action).sort()).toEqual(["create", "rotate"]);
  });

  it("keeps one key per user", async () => {
    const a = await issue(sessionFor("user_a"));
    const b = await issue(sessionFor("user_b"));
    expect(a.body.id).not.toBe(b.body.id);
    expect(await playgroundRows()).toHaveLength(2);
  });

  it("returns the tenant's custom prefix as base path", async () => {
    await env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, created_at, is_root_tenant, system_prefix, custom_prefix) VALUES ('org_pg', 'Acme', 'acme', 0, 0, 'proxy_sys', 'acme')",
    ).run();
    const { body } = await issue(sessionFor("user_a"));
    expect(body.basePath).toBe("acme");
  });

  it("returns the system prefix of a non-root tenant without a custom one", async () => {
    await env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, created_at, is_root_tenant, system_prefix, custom_prefix) VALUES ('org_pg', 'Acme', 'acme', 0, 0, 'proxy_sys', NULL)",
    ).run();
    const { body } = await issue(sessionFor("user_a"));
    expect(body.basePath).toBe("proxy_sys");
  });

  it("returns no base path for the root tenant", async () => {
    await env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, created_at, is_root_tenant, system_prefix, custom_prefix) VALUES ('org_pg', 'Acme', 'acme', 0, 1, 'proxy_sys', NULL)",
    ).run();
    const { body } = await issue(sessionFor("user_a"));
    expect(body.basePath).toBe("");
  });

  it("returns no base path for a non-root tenant without prefixes", async () => {
    await env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, created_at, is_root_tenant, system_prefix, custom_prefix) VALUES ('org_pg', 'Acme', 'acme', 0, 0, NULL, NULL)",
    ).run();
    const { body } = await issue(sessionFor("user_a"));
    expect(body.basePath).toBe("");
  });
});

describe("reserved playground key name", () => {
  it("refuses to create a key with the reserved name", async () => {
    const res = await buildApp(sessionFor("user_a")).request(
      "/api/keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: " playground " }),
      },
      env as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `name '${PLAYGROUND_KEY_NAME}' is reserved`,
    });
  });

  it("refuses to rename a key to the reserved name", async () => {
    const app = buildApp(sessionFor("user_a"));
    const created = await app.request(
      "/api/keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ci" }),
      },
      env as never,
    );
    const { id } = (await created.json()) as { id: string };
    const res = await app.request(
      `/api/keys/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Playground" }),
      },
      env as never,
    );
    expect(res.status).toBe(400);
  });
});
