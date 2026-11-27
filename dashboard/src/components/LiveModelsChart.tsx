// [fork] W22: busy time per model, stacked, on a real time axis.
import type { ModelActivity } from "../lib/api";
import { LIVE_SYNC, axisTick } from "../lib/liveChart";
import {
  modelChartPoints,
  modelColor,
  modelSeriesKey,
} from "../lib/liveModels";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function LiveModelsChart({
  models,
  domain,
}: {
  models: ModelActivity[];
  /** [from, to] in ms. */
  domain: [number, number];
}) {
  const span = domain[1] - domain[0];
  const keys = models.map(modelSeriesKey);
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart
        data={modelChartPoints(models)}
        margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
        {...LIVE_SYNC}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain}
          allowDataOverflow
          tick={{ fontSize: 11 }}
          tickFormatter={(t) => axisTick(Number(t), span)}
          minTickGap={40}
        />
        <YAxis tick={{ fontSize: 11 }} allowDecimals />
        <Tooltip
          formatter={(v) => Number(v).toFixed(2)}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {models.map((m) => {
          const key = modelSeriesKey(m);
          const color = modelColor(key, keys);
          return (
            <Area
              key={key}
              type="linear"
              dataKey={key}
              name={m.label}
              stackId="busy"
              stroke={color}
              fill={color}
              fillOpacity={0.35}
              isAnimationActive={false}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}
