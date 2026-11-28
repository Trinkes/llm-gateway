// [fork] W23: status, timing, error and curl of the playground's last request.
import type { CallMeta } from "../lib/useGatewayCall";
import { Badge, Button } from "./ui";
import { Check, Code2, Copy } from "lucide-react";
import { useState } from "react";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function PlaygroundCallMeta({
  meta,
  error,
  extra,
}: {
  meta: CallMeta | null;
  error: string | null;
  extra?: string | null;
}) {
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!meta && !error) return null;

  const copy = () => {
    if (!meta) return;
    void navigator.clipboard.writeText(meta.curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
        {meta && (
          <Badge tone={meta.status < 400 ? "green" : "red"}>
            {meta.status}
          </Badge>
        )}
        {meta && <span>first byte {fmtMs(meta.firstByteMs)}</span>}
        {meta?.totalMs != null && <span>· total {fmtMs(meta.totalMs)}</span>}
        {extra && <span>· {extra}</span>}
        {meta && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setShowCode((v) => !v)}
          >
            <Code2 size={14} /> {showCode ? "Hide code" : "Code"}
          </Button>
        )}
      </div>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 break-words">
          {error}
        </div>
      )}
      {meta && showCode && (
        <div className="relative">
          <pre className="max-h-72 overflow-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
            {meta.curl}
          </pre>
          <button
            type="button"
            onClick={copy}
            className="absolute right-2 top-2 rounded bg-gray-700 p-1 text-gray-200 hover:bg-gray-600"
            aria-label="Copy curl command"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}
