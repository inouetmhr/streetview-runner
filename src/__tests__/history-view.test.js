import { describe, it, expect } from "vitest";
import { formatDuration, formatAvgSpeed } from "../../public/history-view.js";

describe("history formatting", () => {
  it("formats durations as minutes or h:mm", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(12 * 60)).toBe("12 min");
    expect(formatDuration(3725)).toBe("1:02");
  });

  it("computes the average speed in km/h", () => {
    expect(formatAvgSpeed(15000, 3600)).toBe("15.0 km/h");
    expect(formatAvgSpeed(1000, 0)).toBe("—");
  });
});
