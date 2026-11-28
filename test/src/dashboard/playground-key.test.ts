// [fork] W23: the playground's key issuing and the gateway retry.
import { describe, expect, it, vi, afterEach } from "vitest";

type Call = { url: string; init?: RequestInit };

async function load(replies: ((call: Call) => Response)[]) {
  vi.resetModules();
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return replies[i++](call);
  });
  const mod = await import("../../../dashboard/src/lib/playgroundKey");
  return { mod, calls };
}

const nowS = () => Math.floor(Date.now() / 1000);
const issued = (key: string, basePath = "", ttl = 86400) =>
  Response.json({ key, expiresAt: nowS() + ttl, basePath });
const bearer = (c: Call) => new Headers(c.init?.headers).get("Authorization");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playgroundKey", () => {
  it("issues once and reuses the key while it is usable", async () => {
    const { mod, calls } = await load([() => issued("sk_a")]);
    const [a, b] = await Promise.all([
      mod.playgroundKey(),
      mod.playgroundKey(),
    ]);
    expect(a.key).toBe("sk_a");
    expect(b.key).toBe("sk_a");
    expect((await mod.playgroundKey()).key).toBe("sk_a");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/playground/key");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("renews a key that is about to expire, or on request", async () => {
    const { mod, calls } = await load([
      () => issued("sk_a", "", 60),
      () => issued("sk_b"),
      () => issued("sk_c"),
    ]);
    expect((await mod.playgroundKey()).key).toBe("sk_a");
    expect((await mod.playgroundKey()).key).toBe("sk_b");
    expect((await mod.playgroundKey(true)).key).toBe("sk_c");
    expect(calls).toHaveLength(3);
  });

  it("reuses a key stored by an earlier page in this tab", async () => {
    const stored = { key: "sk_old", expiresAt: nowS() + 3600, basePath: "" };
    vi.stubGlobal("sessionStorage", {
      getItem: () => JSON.stringify(stored),
      setItem: () => {},
    });
    const { mod, calls } = await load([]);
    expect((await mod.playgroundKey()).key).toBe("sk_old");
    expect(calls).toHaveLength(0);
  });

  it("stores a newly issued key", async () => {
    const saved: string[] = [];
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: (_k: string, v: string) => saved.push(v),
    });
    const { mod } = await load([() => issued("sk_new")]);
    await mod.playgroundKey();
    expect(JSON.parse(saved[0]).key).toBe("sk_new");
  });

  it("surfaces an issuing error", async () => {
    const { mod } = await load([
      () => Response.json({ error: "Forbidden" }, { status: 403 }),
    ]);
    await expect(mod.playgroundKey()).rejects.toThrow("Forbidden");
  });
});

describe("gatewayFetch", () => {
  it("calls under the tenant prefix with the key", async () => {
    const { mod, calls } = await load([
      () => issued("sk_a", "acme"),
      () => Response.json({ data: [] }),
    ]);
    const { res, url } = await mod.gatewayFetch("/v1/models", {
      headers: { "X-Test": "1" },
    });
    expect(res.status).toBe(200);
    expect(url).toBe("/acme/v1/models");
    expect(bearer(calls[1])).toBe("Bearer sk_a");
    expect(new Headers(calls[1].init?.headers).get("X-Test")).toBe("1");
  });

  it.each([
    [401, "Invalid API key"],
    [403, "API key is revoked"],
    [403, "API key has expired"],
  ])("retries once with a new key after %s %s", async (status, error) => {
    const { mod, calls } = await load([
      () => issued("sk_a"),
      () => Response.json({ error }, { status }),
      () => issued("sk_b"),
      () => Response.json({ ok: true }),
    ]);
    const { res } = await mod.gatewayFetch("/v1/models");
    expect(res.status).toBe(200);
    expect(bearer(calls[3])).toBe("Bearer sk_b");
  });

  it("returns other errors without retrying", async () => {
    const { mod, calls } = await load([
      () => issued("sk_a"),
      () => Response.json({ error: "model not allowed" }, { status: 403 }),
    ]);
    const { res } = await mod.gatewayFetch("/v1/chat/completions");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "model not allowed" });
    expect(calls).toHaveLength(2);
  });
});
