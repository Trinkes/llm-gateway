// [fork] W17: the box's energy split across request kinds by busy time.
import { fmtCount, fmtUsd, fmtUsdPrecise, pct } from "../lib/format";
import type { KindEnergy } from "../lib/powerTypes";
import { formatUsage } from "../lib/requestKinds";
import { Card } from "./ui";

const fmtKwh = (v: number) =>
  `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 1 })} kWh`;

function usageOf(k: KindEnergy): string {
  return formatUsage(k.unit, {
    tokensInput: k.tokensInput,
    tokensOutput: k.tokensOutput,
    units: k.units,
    latencyMs: k.busySeconds * 1000,
  });
}

export function PowerKindsCard({ kinds }: { kinds: KindEnergy[] }) {
  if (kinds.length === 0) return null;
  return (
    <Card
      title="Energy by kind"
      subtitle="Measured energy split by each kind's busy time, so overlapping requests make the split approximate."
    >
      <div className="-m-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
              <th className="px-5 py-3 font-medium">Kind</th>
              <th className="px-5 py-3 text-right font-medium">Requests</th>
              <th className="px-5 py-3 text-right font-medium">Usage</th>
              <th className="px-5 py-3 text-right font-medium">Busy share</th>
              <th className="px-5 py-3 text-right font-medium">Energy</th>
              <th className="px-5 py-3 text-right font-medium">Electricity</th>
              <th className="px-5 py-3 text-right font-medium">Per unit</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr
                key={k.kind}
                className="border-b border-gray-50 last:border-0"
              >
                <td className="px-5 py-3 font-medium">{k.label}</td>
                <td className="px-5 py-3 text-right">{fmtCount(k.requests)}</td>
                <td className="px-5 py-3 text-right text-gray-600">
                  {usageOf(k)}
                </td>
                <td className="px-5 py-3 text-right text-gray-600">
                  {pct(k.share)}
                </td>
                <td className="px-5 py-3 text-right text-gray-600">
                  {fmtKwh(k.kwh)}
                </td>
                <td className="px-5 py-3 text-right text-gray-700">
                  {k.electricityUsd === null ? "—" : fmtUsd(k.electricityUsd)}
                </td>
                <td className="px-5 py-3 text-right text-gray-700">
                  {k.perUnitUsd === null || k.perUnit === null
                    ? "—"
                    : `${fmtUsdPrecise(k.perUnitUsd)} per ${k.perUnit}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
