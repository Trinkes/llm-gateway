// [fork] W12: CPU / GPU / SSD temperature, APU and wall power on a real time axis.
import type { LivePoint } from "../lib/liveSeries";
import { TEMP_LINES } from "../lib/liveTempLines";
import { LiveLineChart } from "./LiveLineChart";

export function LiveTempChart({
  data,
  domain,
}: {
  data: LivePoint[];
  /** [from, to] in ms. */
  domain: [number, number];
}) {
  return (
    <LiveLineChart
      data={data}
      domain={domain}
      lines={TEMP_LINES}
      left={{
        tick: (v) => `${Math.round(v)}°`,
        value: (v) => `${v.toFixed(1)} °C`,
      }}
      right={{
        tick: (v) => `${Math.round(v)}W`,
        value: (v) => `${v.toFixed(0)} W`,
      }}
    />
  );
}
