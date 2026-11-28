// [fork] W23: the playground's own API key (POST /api/playground/key) and the
// gateway calls made with it. The secret lives in this tab's sessionStorage
// only; a missing, stale or rejected one is replaced by asking for a new one.
import { apiSend } from "./api";

export interface PlaygroundKey {
  key: string;
  expiresAt: number;
  basePath: string;
}

const STORAGE_KEY = "playground.key";
/** Ask for a new secret this long before the current one expires. */
const RENEW_MARGIN_S = 10 * 60;

let current: PlaygroundKey | null = null;
let pending: Promise<PlaygroundKey> | null = null;

export function isUsable(key: PlaygroundKey | null, nowS: number): boolean {
  return !!key && key.expiresAt - RENEW_MARGIN_S > nowS;
}

/** Gateway path under the tenant's prefix, e.g. `/acme/v1/models`. */
export function gatewayPath(basePath: string, path: string): string {
  const prefix = basePath.replace(/^\/+|\/+$/g, "");
  return prefix ? `/${prefix}${path}` : path;
}

function readStored(): PlaygroundKey | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PlaygroundKey) : null;
  } catch {
    return null;
  }
}

function store(key: PlaygroundKey): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(key));
  } catch {
    // Storage blocked: the key still lives in memory for this page.
  }
}

/** A working playground key, issuing a new secret when needed. */
export function playgroundKey(renew = false): Promise<PlaygroundKey> {
  const nowS = Date.now() / 1000;
  current ??= readStored();
  if (!renew && isUsable(current, nowS)) return Promise.resolve(current!);
  pending ??= apiSend<PlaygroundKey>("POST", "/api/playground/key")
    .then((key) => {
      current = key;
      store(key);
      return key;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Whether a gateway reply means the key itself was refused. */
async function keyRefused(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  const text = await res.clone().text();
  return /API key (is revoked|has expired)/.test(text);
}

/** Call the gateway with the playground key; one retry with a new secret. */
export async function gatewayFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ res: Response; url: string }> {
  const send = async (key: PlaygroundKey) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${key.key}`);
    const url = gatewayPath(key.basePath, path);
    return { res: await fetch(url, { ...init, headers }), url };
  };
  const first = await send(await playgroundKey());
  if (!(await keyRefused(first.res))) return first;
  return send(await playgroundKey(true));
}

/** The error text of a failed gateway reply, whatever shape it has. */
export function errorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string };
      detail?: string;
      message?: string;
    };
    const err = parsed.error;
    const message =
      (typeof err === "string" ? err : err?.message) ??
      parsed.detail ??
      parsed.message;
    if (message) return `${status}: ${message}`;
  } catch {
    // not JSON
  }
  return body.trim()
    ? `${status}: ${body.trim().slice(0, 500)}`
    : `Request failed (${status})`;
}
