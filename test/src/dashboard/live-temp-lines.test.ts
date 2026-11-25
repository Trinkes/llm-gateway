// [fork] W14: the Live temperature and power chart draws wall watts beside APU watts.
import { TEMP_LINES } from "../../../dashboard/src/lib/liveTempLines";
import { describe, expect, it } from "vitest";

describe("TEMP_LINES", () => {
  it("puts APU and wall watts on the right axis", () => {
    const watts = TEMP_LINES.filter((l) => l.axis === "right");
    expect(watts.map((l) => [l.key, l.name])).toEqual([
      ["gpuPowerW", "APU W"],
      ["wallPowerW", "Wall W"],
    ]);
  });
});
