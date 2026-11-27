// [fork] W17: per-kind totals table, shared by Analytics and API key detail.
import { fmtCount, fmtMs, fmtUsdPrecise } from "../lib/format";
import { formatKindUsage, KindUsage } from "../lib/requestKinds";
import { Badge, Card, EmptyState } from "./ui";

/** One row per request kind, each measured in its own unit. */
export function KindUsageCard({
  kinds,
  subtitle = "Each kind is measured in its own unit.",
}: {
  kinds: KindUsage[];
  subtitle?: string;
}) {
  return (
    <Card title="By kind" subtitle={subtitle}>
      {kinds.length === 0 ? (
        <EmptyState title="No usage yet" />
      ) : (
        <div className="-m-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                <th className="px-5 py-3 font-medium">Kind</th>
                <th className="px-5 py-3 font-medium">Requests</th>
                <th className="px-5 py-3 font-medium">Errors</th>
                <th className="px-5 py-3 text-right font-medium">Usage</th>
                <th className="px-5 py-3 font-medium">Avg latency</th>
                <th className="px-5 py-3 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr
                  key={k.kind}
                  className="border-b border-gray-50 last:border-0"
                >
                  <td className="px-5 py-3 font-medium">{k.label}</td>
                  <td className="px-5 py-3">{fmtCount(k.requests)}</td>
                  <td className="px-5 py-3">
                    {k.errors > 0 ? (
                      <Badge tone="red">{fmtCount(k.errors)}</Badge>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600">
                    {formatKindUsage(k)}
                  </td>
                  <td className="px-5 py-3">{fmtMs(k.latencyAvgMs)}</td>
                  <td className="px-5 py-3 text-right text-gray-700">
                    {fmtUsdPrecise(k.costUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
