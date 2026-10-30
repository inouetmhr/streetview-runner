import { describe, it, expect } from "vitest";
import { createSpeedMeter } from "../../public/speed-meter.js";

// Feeds a steady speed (m/s) for `seconds`, one sample per second.
function ride(meter, mps, seconds, startMs = 1000) {
  let t = startMs;
  for (let i = 0; i < seconds; i++) {
    t += 1000;
    meter.record(mps, t);
  }
  return t;
}

describe("speed meter", () => {
  it("starts at 0 and converges toward a steady speed", () => {
    const meter = createSpeedMeter();
    expect(meter.kmh).toBe(0);
    ride(meter, 5, 60); // 5 m/s = 18 km/h
    expect(meter.kmh).toBeGreaterThan(17);
    expect(meter.kmh).toBeLessThan(18.5);
  });

  it("smooths a sudden start instead of jumping", () => {
    const meter = createSpeedMeter();
    ride(meter, 5, 2);
    expect(meter.kmh).toBeGreaterThan(0);
    expect(meter.kmh).toBeLessThan(18 / 2);
  });

  it("decays toward 0 once movement stops and then reports nothing to do", () => {
    const meter = createSpeedMeter();
    let t = ride(meter, 5, 30);
    const before = meter.kmh;
    t += 5000;
    const after = meter.decay(t);
    expect(after).toBeLessThan(before);
    for (let i = 0; i < 20 && meter.kmh > 0; i++) meter.decay(t += 30000);
    expect(meter.kmh).toBe(0);
    expect(meter.decay(t + 5000)).toBeNull();
  });

  it("resets to 0", () => {
    const meter = createSpeedMeter();
    ride(meter, 5, 10);
    meter.reset();
    expect(meter.kmh).toBe(0);
    expect(meter.decay(Date.now())).toBeNull();
  });
});
