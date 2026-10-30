import { describe, it, expect } from "vitest";
import { parseIndoorBikeData } from "../../public/ble.js";

// Builds an Indoor Bike Data record: uint16 flags followed by little-endian fields.
function record(flags, bytes) {
  const buf = new Uint8Array([flags & 0xff, flags >> 8, ...bytes]);
  return new DataView(buf.buffer);
}

describe("parseIndoorBikeData", () => {
  it("reads speed, cadence and total distance", () => {
    // flags: cadence (bit 2) + total distance (bit 4); speed present because More Data is clear
    const dv = record((1 << 2) | (1 << 4), [
      0x10, 0x0e,       // speed 3600 * 0.01 = 36.00 km/h
      0xb4, 0x00,       // cadence 180 * 0.5 = 90 rpm
      0x39, 0x30, 0x00, // distance 12345 m
    ]);
    expect(parseIndoorBikeData(dv)).toEqual({
      instantaneous_speed: 36,
      instantaneous_cadence: 90,
      total_distance: 12345,
    });
  });

  it("skips the speed field when More Data is set", () => {
    const dv = record((1 << 0) | (1 << 2), [0xb4, 0x00]);
    expect(parseIndoorBikeData(dv)).toEqual({ instantaneous_cadence: 90 });
  });

  it("walks past optional fields to reach heart rate", () => {
    // average speed (bit 1), power (bit 6), heart rate (bit 9)
    const dv = record((1 << 1) | (1 << 6) | (1 << 9), [
      0xe8, 0x03, // speed 10 km/h
      0xd0, 0x07, // average speed 20 km/h
      0x96, 0x00, // power 150 W
      0x8c,       // heart rate 140 bpm
    ]);
    const data = parseIndoorBikeData(dv);
    expect(data.instantaneous_speed).toBe(10);
    expect(data.average_speed).toBe(20);
    expect(data.instantaneous_power).toBe(150);
    expect(data.heart_rate).toBe(140);
  });
});
