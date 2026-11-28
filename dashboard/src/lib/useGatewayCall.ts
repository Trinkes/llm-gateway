// [fork] W23: one playground request at a time: timing, errors, abort and the
// request as curl.
import { buildCurl, type CurlBody } from "./playgroundCurl";
import { errorText, gatewayFetch } from "./playgroundKey";
import { useCallback, useRef, useState } from "react";

export interface CallMeta {
  status: number;
  /** Time to the reply's headers. */
  firstByteMs: number;
  /** Time until the body was fully read; null while it still streams. */
  totalMs: number | null;
  curl: string;
}

export interface GatewayCall {
  busy: boolean;
  error: string | null;
  meta: CallMeta | null;
  /** The reply when it succeeded; null after an error or abort. */
  send(
    path: string,
    init: RequestInit,
    curl: CurlBody,
  ): Promise<Response | null>;
  /** Mark the reply's body as fully read. */
  done(): void;
  fail(message: string): void;
  stop(): void;
  /** Signal of the request in flight, for readers that stream the body. */
  signal(): AbortSignal | undefined;
}

export function useGatewayCall(): GatewayCall {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<CallMeta | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);

  const done = useCallback(() => {
    const totalMs = Math.round(performance.now() - started.current);
    setMeta((m) => (m ? { ...m, totalMs } : m));
    setBusy(false);
    abort.current = null;
  }, []);

  const fail = useCallback((message: string) => {
    setError(message);
    setBusy(false);
    abort.current = null;
  }, []);

  const send = useCallback(
    async (path: string, init: RequestInit, curl: CurlBody) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      started.current = performance.now();
      setBusy(true);
      setError(null);
      setMeta(null);
      try {
        const { res, url } = await gatewayFetch(path, {
          ...init,
          signal: controller.signal,
        });
        const firstByteMs = Math.round(performance.now() - started.current);
        setMeta({
          status: res.status,
          firstByteMs,
          totalMs: null,
          curl: buildCurl(new URL(url, window.location.origin).href, curl),
        });
        if (!res.ok) {
          fail(errorText(res.status, await res.text()));
          return null;
        }
        return res;
      } catch (err) {
        if (controller.signal.aborted) {
          fail("Stopped");
        } else {
          fail((err as Error).message || "Request failed");
        }
        return null;
      }
    },
    [fail],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  const signal = useCallback(() => abort.current?.signal, []);

  return { busy, error, meta, send, done, fail, stop, signal };
}
