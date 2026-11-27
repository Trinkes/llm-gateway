import requestUnits from "../../../migrations/0009_request_units.sql?raw";
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const ORG = "org_units_migration";

/** The backfill UPDATE of migration 0009, comments removed. */
const BACKFILL = requestUnits
  .replace(/--.*$/gm, "")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .find((s) => s.startsWith("UPDATE request_metrics"))!;

async function insert(
  id: string,
  method: string,
  status: number,
  units: number | null,
) {
  await env.DB.prepare(
    `INSERT INTO request_metrics
       (id, organization_id, timestamp, provider, model, method, status_code,
        latency_ms, cost_usd, cache_hit, units)
     VALUES (?, ?, 1000, 'local', 'm', ?, ?, 10, 0, 0, ?)`,
  )
    .bind(id, ORG, method, status, units)
    .run();
}

async function unitsOf(id: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT units FROM request_metrics WHERE id = ?",
  )
    .bind(id)
    .first<{ units: number | null }>();
  return row!.units;
}

describe("migration 0009 backfill", () => {
  beforeAll(async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER, units INTEGER);",
    );
  });

  beforeEach(async () => {
    await env.DB.exec(
      `DELETE FROM request_metrics WHERE organization_id = '${ORG}';`,
    );
  });

  it("gives successful pre-W17 image rows one unit and leaves other rows alone", async () => {
    await insert("u_img_ok", "image", 200, null);
    await insert("u_img_err", "image", 500, null);
    await insert("u_img_n", "image", 200, 4);
    await insert("u_chat", "chat", 200, null);
    await insert("u_audio", "audio", 200, null);

    await env.DB.exec(BACKFILL);

    expect(await unitsOf("u_img_ok")).toBe(1);
    expect(await unitsOf("u_img_err")).toBeNull();
    expect(await unitsOf("u_img_n")).toBe(4);
    expect(await unitsOf("u_chat")).toBeNull();
    expect(await unitsOf("u_audio")).toBeNull();
  });
});
