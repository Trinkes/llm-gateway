// [fork] W12: lines of the Live temperature and power chart.
// [fork] W14: wall-meter watts beside the APU's; the gap is the non-APU draw.
import type { ChartLine } from "../components/LiveLineChart";
import type { LivePoint } from "./liveSeries";

export const TEMP_LINES: ChartLine<LivePoint>[] = [
  { key: "cpuTempC", name: "CPU °C", color: "#ef4444" },
  { key: "gpuTempC", name: "GPU °C", color: "#f59e0b" },
  { key: "ssdTempC", name: "SSD °C", color: "#10b981" },
  {
    key: "gpuPowerW",
    name: "APU W",
    color: "#6366f1",
    axis: "right",
    dashed: true,
  },
  {
    key: "wallPowerW",
    name: "Wall W",
    color: "#0ea5e9",
    axis: "right",
    dashed: true,
  },
];
