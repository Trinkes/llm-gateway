import { env } from "cloudflare:test";
import { Hono } from "hono";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { runAlertChecks } from "~/src/alerts/evaluator";
import { signWebhookPayload } from "~/src/alerts/webhooks";
import { alertsRouter } from "~/src/api/alerts";
import type { AppBindings } from "~/src/app";
import { seedTemplates } from "~/src/email/templates";
import type { SessionAuth } from "~/src/types";
import { nowSeconds } from "~/src/utils/crypto";

const ORG = "org_alerts";
const ownerSession: SessionAuth = {
  userId: "user_owner",
  sessionId: "sess_owner",
  organizationId: ORG,
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

function buildApp(session: SessionAuth): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/api/alerts", alertsRouter);
  return app;
}

async function fetchJson(
  app: Hono<AppBindings>,
  path: string,
  init?: RequestInit,
) {
  const res = await app.request(path, init, env as never);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

async function seedRequest(
  provider: string,
  statusCode: number,
  costUsd: number,
  ts = nowSeconds() - 10,
) {
  await env.DB.prepare(
    `INSERT INTO request_metrics (id, organization_id, api_key_id, timestamp, provider, model, method, status_code, latency_ms, tokens_input, tokens_output, tokens_cached, cost_usd, error_message, cache_hit)
     VALUES (?, ?, NULL, ?, ?, 'gpt-4', 'chat', ?, 100, 100, 50, 0, ?, NULL, 0)`,
  )
    .bind(
      `metric_${Math.random().toString(36).slice(2)}`,
      ORG,
      ts,
      provider,
      statusCode,
      costUsd,
    )
    .run();
}

async function setAlertSetting(key: string, value: unknown) {
  const current = await env.DB.prepare(
    "SELECT value FROM tenant_settings WHERE organization_id = ? AND key = 'alerts'",
  )
    .bind(ORG)
    .first<{ value: string }>();
  const merged = {
    ...(current ? JSON.parse(current.value) : {}),
    [key]: value,
  };
  await env.DB.prepare(
    `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
     VALUES (?, 'alerts', ?, ?)
     ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value`,
  )
    .bind(ORG, JSON.stringify(merged), nowSeconds())
    .run();
}

async function alertEvents() {
  const { results } = await env.DB.prepare(
    "SELECT event_type, provider, level, channel, status FROM alert_events WHERE organization_id = ? ORDER BY created_at ASC, id ASC",
  )
    .bind(ORG)
    .all<{
      event_type: string;
      provider: string | null;
      level: number;
      channel: string;
      status: string;
    }>();
  return results;
}

async function countEvents() {
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alert_events WHERE organization_id = ?",
  )
    .bind(ORG)
    .all<{ n: number }>();
  return results[0].n;
}

beforeAll(async () => {
  await env.DB.exec(`
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER, metadata TEXT, system_prefix TEXT UNIQUE, custom_prefix TEXT UNIQUE, is_root_tenant INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (organization_id, key));
CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER, units INTEGER);
CREATE TABLE IF NOT EXISTS alert_events (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, event_type TEXT NOT NULL, provider TEXT, level REAL NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', message_id TEXT, payload TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, spend_disabled_until INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]', secret TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_email_templates (template_id TEXT PRIMARY KEY, template_name TEXT NOT NULL, template_type TEXT NOT NULL, subject_template TEXT NOT NULL, body_markdown TEXT NOT NULL, variables TEXT, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS system_email_logs (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), batch_id TEXT, recipient_email TEXT NOT NULL, recipient_user_id TEXT, template_id TEXT NOT NULL, subject TEXT, status TEXT NOT NULL DEFAULT 'pending', provider TEXT, provider_message_id TEXT, error_message TEXT, error_code TEXT, metadata TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), sent_at INTEGER);
`);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, createdAt, updatedAt) VALUES (?, 'Acme Alerts', 1, 1)`,
    ).bind(ORG),
    env.DB.prepare(
      `INSERT OR REPLACE INTO users (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('user_owner', 'Owner', 'owner@acme.test', 1, 1, 1),
              ('user_admin', 'Admin', 'admin@acme.test', 1, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO members (id, organizationId, userId, role, createdAt)
       VALUES ('m_owner', ?, 'user_owner', 'owner', 1),
              ('m_admin', ?, 'user_admin', 'admin', 2)`,
    ).bind(ORG, ORG),
  ]);
  await seedTemplates(env);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alert_events WHERE organization_id = ?").bind(
      ORG,
    ),
    env.DB.prepare(
      "DELETE FROM request_metrics WHERE organization_id = ?",
    ).bind(ORG),
    env.DB.prepare("DELETE FROM webhooks WHERE organization_id = ?").bind(ORG),
    env.DB.prepare("DELETE FROM api_keys WHERE organization_id = ?").bind(ORG),
    env.DB.prepare("DELETE FROM system_email_logs"),
    env.DB.prepare(
      "DELETE FROM tenant_settings WHERE organization_id = ?",
    ).bind(ORG),
  ]);
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("runAlertChecks — spend alerts", () => {
  it("fires at 80%, escalates to 90% and 100%, and dedups within a level", async () => {
    await env.DB.prepare(
      `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
       VALUES (?, 'spendLimits', ?, ?)`,
    )
      .bind(ORG, JSON.stringify({ dailyUsd: 100 }), nowSeconds())
      .run();

    const now = nowSeconds() - 10;
    await seedRequest("openai", 200, 80, now);
    let result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    let events = await alertEvents();
    expect(
      events.some((e) => e.event_type === "spend_daily" && e.level === 80),
    ).toBe(true);

    // Cooldown: same level is not re-sent.
    result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(0);

    // Escalate to 90%.
    await seedRequest("openai", 200, 15, now);
    result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    events = await alertEvents();
    expect(
      events.some((e) => e.event_type === "spend_daily" && e.level === 90),
    ).toBe(true);

    // Escalate past 100%.
    await seedRequest("openai", 200, 60, now);
    result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    events = await alertEvents();
    expect(
      events.some((e) => e.event_type === "spend_daily" && e.level === 100),
    ).toBe(true);
    expect(
      events.filter((e) => e.event_type === "spend_daily").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("does not alert below the 80% threshold", async () => {
    await env.DB.prepare(
      `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
       VALUES (?, 'spendLimits', ?, ?)`,
    )
      .bind(ORG, JSON.stringify({ dailyUsd: 100 }), nowSeconds())
      .run();
    await seedRequest("openai", 200, 79, nowSeconds() - 10);
    const result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(0);
    expect(await countEvents()).toBe(0);
  });
});

describe("runAlertChecks — error-rate alerts", () => {
  it("alerts per provider above threshold with enough traffic", async () => {
    const now = nowSeconds() - 10;
    for (let i = 0; i < 30; i++) {
      await seedRequest("openai", 200, 0.01, now);
    }
    for (let i = 0; i < 10; i++) {
      await seedRequest("openai", 500, 0.01, now);
    }
    // Below the minimum request volume — must not alert.
    for (let i = 0; i < 5; i++) {
      await seedRequest("deepseek", 500, 0.01, now);
    }

    const result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    const events = await alertEvents();
    const err = events.find((e) => e.event_type === "error_rate");
    expect(err?.provider).toBe("openai");
    expect(err?.level).toBe(25);
    expect(events.some((e) => e.provider === "deepseek")).toBe(false);
  });

  it("dedups error-rate alerts within the cooldown", async () => {
    const now = nowSeconds() - 10;
    for (let i = 0; i < 30; i++) await seedRequest("openai", 200, 0.01, now);
    for (let i = 0; i < 10; i++) await seedRequest("openai", 500, 0.01, now);

    await runAlertChecks(env);
    expect(await countEvents()).toBeGreaterThan(0);
    const eventsAfterFirst = await countEvents();
    const second = await runAlertChecks(env);
    expect(second.alertsSent).toBe(0);
    expect(await countEvents()).toBe(eventsAfterFirst);
  });
});

const DAY = 86400;

async function seedKey(
  id: string,
  createdAt: number,
  expiresAt: number | null,
  status = "active",
) {
  await env.DB.prepare(
    `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, 'sk_live_', 'user_owner', ?, ?, ?)`,
  )
    .bind(id, ORG, `name-${id}`, `hash-${id}`, createdAt, expiresAt, status)
    .run();
}

async function setKeyExpiry(id: string, expiresAt: number) {
  await env.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
    .bind(expiresAt, id)
    .run();
}

/** Subscribe a webhook to key_expiring and capture delivered payloads. */
async function captureExpiryWebhooks() {
  await env.DB.prepare(
    `INSERT INTO webhooks (id, organization_id, url, events, secret, enabled, created_at)
     VALUES ('wh_exp', ?, 'https://hooks.acme.test/exp', ?, NULL, 1, ?)`,
  )
    .bind(ORG, JSON.stringify(["key_expiring"]), nowSeconds())
    .run();
  const payloads: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      payloads.push(JSON.parse(init?.body as string));
      return new Response("{}", { status: 200 });
    }),
  );
  return payloads;
}

describe("runAlertChecks — API key expiry", () => {
  it("warns at 7 days, then at 1 day, once per level", async () => {
    const payloads = await captureExpiryWebhooks();
    const now = nowSeconds();
    await seedKey("key_a", now - 30 * DAY, now + 5 * DAY + 3600);

    let result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    let events = (await alertEvents()).filter(
      (e) => e.event_type === "key_expiring",
    );
    expect(events.map((e) => [e.provider, e.level, e.channel]).sort()).toEqual([
      ["key_a", 7, "email"],
      ["key_a", 7, "email"],
      ["key_a", 7, "webhook"],
    ]);

    // Same level is not re-sent.
    result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(0);

    await setKeyExpiry("key_a", now + 12 * 3600 + 60);
    result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    events = (await alertEvents()).filter(
      (e) => e.event_type === "key_expiring" && e.level === 1,
    );
    expect(events).toHaveLength(3);

    expect(payloads.map((p) => p.timeLeft)).toEqual(["5 days", "12 hours"]);
  });

  it("words 1 day and 1 hour in the singular", async () => {
    const payloads = await captureExpiryWebhooks();
    const now = nowSeconds();
    await seedKey("key_day", now - 30 * DAY, now + DAY + 3 * 3600);
    await seedKey("key_hour", now - 30 * DAY, now + 3600 + 600);

    const result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(2);
    expect(
      Object.fromEntries(payloads.map((p) => [p.keyId, p.timeLeft])),
    ).toEqual({ key_day: "1 day", key_hour: "1 hour" });
  });

  it("skips levels the key was created inside of", async () => {
    const now = nowSeconds();
    // 3-day key, 2.5 days left: no 7-day warning.
    await seedKey("key_short", now - 12 * 3600, now + 2 * DAY + 12 * 3600);
    // 1-hour key: no warnings at all.
    await seedKey("key_tiny", now - 1800, now + 1800);

    let result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(0);

    // The 3-day key still gets its 1-day warning.
    await setKeyExpiry("key_short", now + 20 * 3600);
    result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(1);
    const events = await alertEvents();
    expect(events.every((e) => e.provider === "key_short")).toBe(true);
    expect(events.every((e) => e.level === 1)).toBe(true);
  });

  it("ignores revoked, expired, far-off and non-expiring keys", async () => {
    const now = nowSeconds();
    await seedKey("key_revoked", now - 30 * DAY, now + 3 * DAY, "revoked");
    await seedKey("key_past", now - 30 * DAY, now - 60);
    await seedKey("key_far", now - 30 * DAY, now + 30 * DAY);
    await seedKey("key_never", now - 30 * DAY, null);

    const result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(0);
    expect(await countEvents()).toBe(0);
  });

  it("posts a key_expiring webhook with the key details", async () => {
    const payloads = await captureExpiryWebhooks();
    const now = nowSeconds();
    const expiresAt = now + 3 * DAY;
    await seedKey("key_hook", now - 30 * DAY, expiresAt);
    await setAlertSetting("emailEnabled", false);

    await runAlertChecks(env);
    expect(payloads).toHaveLength(1);
    const body = payloads[0];
    expect(body.event).toBe("key_expiring");
    expect(body.keyId).toBe("key_hook");
    expect(body.keyName).toBe("name-key_hook");
    expect(body.expiresAt).toBe(expiresAt);
    expect(body.level).toBe(7);
  });
});

describe("runAlertChecks — webhook delivery + HMAC", () => {
  it("posts to subscribed webhooks with an HMAC signature", async () => {
    await env.DB.prepare(
      `INSERT INTO webhooks (id, organization_id, url, events, secret, enabled, created_at)
       VALUES ('wh_1', ?, 'https://hooks.acme.test/alert', ?, 's3cret', 1, ?)`,
    )
      .bind(ORG, JSON.stringify(["quota_exceeded"]), nowSeconds())
      .run();

    const sent: {
      url: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body as string,
        });
        return new Response("{}", { status: 200 });
      }),
    );

    await env.DB.prepare(
      `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
       VALUES (?, 'spendLimits', ?, ?)`,
    )
      .bind(ORG, JSON.stringify({ dailyUsd: 100 }), nowSeconds())
      .run();
    await seedRequest("openai", 200, 80, nowSeconds() - 10);

    const result = await runAlertChecks(env);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://hooks.acme.test/alert");

    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.event).toBe("quota_exceeded");
    expect(body.organizationId).toBe(ORG);
    expect(body.level).toBe(80);

    const expectedSig = await signWebhookPayload("s3cret", sent[0].body);
    expect(sent[0].headers["x-open-llm-proxy-signature"]).toBe(
      `sha256=${expectedSig}`,
    );

    const events = await alertEvents();
    expect(
      events.some((e) => e.channel === "webhook" && e.status === "sent"),
    ).toBe(true);
    expect(result.deliveries).toBeGreaterThan(0);
  });

  it("skips disabled or non-matching subscriptions", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webhooks (id, organization_id, url, events, enabled, created_at)
         VALUES ('wh_disabled', ?, 'https://hooks.acme.test/off', ?, 0, ?)`,
      ).bind(ORG, JSON.stringify(["*"]), nowSeconds()),
      env.DB.prepare(
        `INSERT INTO webhooks (id, organization_id, url, events, enabled, created_at)
         VALUES ('wh_other', ?, 'https://hooks.acme.test/other', ?, 1, ?)`,
      ).bind(ORG, JSON.stringify(["high_error_rate"]), nowSeconds()),
    ]);
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sent.push(url);
        return new Response("{}", { status: 200 });
      }),
    );

    await env.DB.prepare(
      `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
       VALUES (?, 'spendLimits', ?, ?)`,
    )
      .bind(ORG, JSON.stringify({ dailyUsd: 100 }), nowSeconds())
      .run();
    await seedRequest("openai", 200, 80, nowSeconds() - 10);
    await runAlertChecks(env);
    expect(sent).toHaveLength(0);
  });
});

describe("runAlertChecks — disabled org", () => {
  it("skips organizations with alerts disabled", async () => {
    await setAlertSetting("enabled", false);
    await env.DB.prepare(
      `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
       VALUES (?, 'spendLimits', ?, ?)`,
    )
      .bind(ORG, JSON.stringify({ dailyUsd: 100 }), nowSeconds())
      .run();
    await seedRequest("openai", 200, 90, nowSeconds() - 10);
    const result = await runAlertChecks(env);
    expect(result.alertsSent).toBe(0);
    expect(await countEvents()).toBe(0);
  });
});

describe("GET/PUT /api/alerts/config", () => {
  it("returns defaults, validates patches, and persists", async () => {
    const app = buildApp(ownerSession);

    const initial = await fetchJson(app, "/api/alerts/config");
    expect(initial.status).toBe(200);
    expect(initial.body.alerts.enabled).toBe(true);
    expect(initial.body.alerts.errorThresholdPct).toBe(5);

    const bad = await fetchJson(app, "/api/alerts/config", {
      method: "PUT",
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(bad.status).toBe(400);

    const zero = await fetchJson(app, "/api/alerts/config", {
      method: "PUT",
      body: JSON.stringify({ errorThresholdPct: 0 }),
    });
    expect(zero.status).toBe(400);

    const ok = await fetchJson(app, "/api/alerts/config", {
      method: "PUT",
      body: JSON.stringify({
        enabled: false,
        emailEnabled: false,
        errorThresholdPct: 10,
        errorMinRequests: 50,
        errorWindowMinutes: 15,
        cooldownMinutes: 120,
      }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.alerts.enabled).toBe(false);
    expect(ok.body.alerts.errorThresholdPct).toBe(10);

    const after = await fetchJson(app, "/api/alerts/config");
    expect(after.body.alerts.emailEnabled).toBe(false);
    expect(after.body.alerts.cooldownMinutes).toBe(120);
  });
});

describe("webhook subscription CRUD", () => {
  it("creates, lists, patches, and deletes subscriptions", async () => {
    const app = buildApp(ownerSession);

    const bad = await fetchJson(app, "/api/alerts/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "not-a-url", events: ["quota_exceeded"] }),
    });
    expect(bad.status).toBe(400);

    const unknownEvent = await fetchJson(app, "/api/alerts/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.acme.test/x",
        events: ["bogus"],
      }),
    });
    expect(unknownEvent.status).toBe(400);

    const noEvents = await fetchJson(app, "/api/alerts/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.acme.test/x", events: [] }),
    });
    expect(noEvents.status).toBe(400);

    const created = await fetchJson(app, "/api/alerts/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.acme.test/x",
        events: ["quota_exceeded", "high_error_rate"],
        secret: "abc123",
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body.webhook.id;

    const list = await fetchJson(app, "/api/alerts/webhooks");
    expect(list.status).toBe(200);
    expect(list.body.webhooks).toHaveLength(1);
    expect(list.body.events).toContain("quota_exceeded");

    const patched = await fetchJson(app, `/api/alerts/webhooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.webhook.enabled).toBe(false);

    const del = await fetchJson(app, `/api/alerts/webhooks/${id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const delAgain = await fetchJson(app, `/api/alerts/webhooks/${id}`, {
      method: "DELETE",
    });
    expect(delAgain.status).toBe(404);

    const missing = await fetchJson(app, "/api/alerts/webhooks/nope", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/alerts/test", () => {
  it("delivers a sample email and webhook payload", async () => {
    const app = buildApp(ownerSession);
    await env.DB.prepare(
      `INSERT INTO webhooks (id, organization_id, url, events, enabled, created_at)
       VALUES ('wh_test', ?, 'https://hooks.acme.test/test', ?, 1, ?)`,
    )
      .bind(ORG, JSON.stringify(["test"]), nowSeconds())
      .run();

    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sent.push(url);
        return new Response("{}", { status: 200 });
      }),
    );

    const res = await fetchJson(app, "/api/alerts/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body.webhooks.delivered).toBe(1);
    expect(sent).toEqual(["https://hooks.acme.test/test"]);
    // Email attempt was processed (via console provider in test/dev environment)
    expect(res.body.email).toBeDefined();
    expect(typeof res.body.email.success).toBe("boolean");
  });
});
