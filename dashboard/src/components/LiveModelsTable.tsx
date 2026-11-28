// [fork] W22: one row per model: request rate, latency, errors, output.
import type { ModelActivity } from "../lib/api";
import { fmtCount, fmtMs } from "../lib/format";
import {
  fmtRate,
  modelSeriesKey,
  modelUsage,
  requestsPerMin,
} from "../lib/liveModels";
import { Badge } from "./ui";

export function LiveModelsTable({
  models,
  windowS,
}: {
  models: ModelActivity[];
  /** Length of the window the stats cover, seconds. */
  windowS: number;
}) {
  return (
    <div className="-mx-5 -mb-5 mt-4 overflow-x-auto border-t border-gray-100">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
            <th className="px-5 py-3 font-medium">Model</th>
            <th className="px-5 py-3 font-medium">Requests/min</th>
            <th className="px-5 py-3 font-medium">Avg latency</th>
            <th className="px-5 py-3 font-medium">Errors</th>
            <th className="px-5 py-3 text-right font-medium">Output</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr
              key={modelSeriesKey(m)}
              className="border-b border-gray-50 last:border-0"
            >
              <td className="px-5 py-3 font-medium">{m.label}</td>
              <td className="px-5 py-3">
                {fmtRate(requestsPerMin(m, windowS))}
              </td>
              <td className="px-5 py-3">{fmtMs(m.latencyAvgMs)}</td>
              <td className="px-5 py-3">
                {m.errors > 0 ? (
                  <Badge tone="red">{fmtCount(m.errors)}</Badge>
                ) : (
                  <span className="text-gray-400">0</span>
                )}
              </td>
              <td className="px-5 py-3 text-right text-gray-600">
                {modelUsage(m)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
