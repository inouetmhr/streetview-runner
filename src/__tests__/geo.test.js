import { describe, it, expect } from "vitest";
import { angleDelta, rideDay, splitSegments, getWeekRangeUTC, getMonthRangeUTC } from "../../public/geo.js";
import { resolveLatestPosition } from "../../public/ride-storage.js";

// `npm test` runs with TZ=Asia/Tokyo so local-time behavior is deterministic.
describe("rideDay", () => {
  it("rolls over at 03:00 local time", () => {
    expect(rideDay(new Date(2026, 9, 30, 2, 59))).toBe("2026-10-29");
    expect(rideDay(new Date(2026, 9, 30, 3, 0))).toBe("2026-10-30");
    expect(rideDay(new Date(2026, 9, 30, 8, 0))).toBe("2026-10-30");
  });
  it("uses the local date, not the UTC date", () => {
    // 2026-10-30 08:00 JST is still 2026-10-29 in UTC.
    expect(rideDay(new Date("2026-10-29T23:00:00Z"))).toBe("2026-10-30");
  });
});

describe("angleDelta", () => {
  it("returns the signed shortest turn", () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(-180);
  });
});

describe("splitSegments", () => {
  it("breaks at warps and drops single-point pieces", () => {
    const a = { lat: 35.0, lng: 139.0 };
    const b = { lat: 35.001, lng: 139.0 };
    const far = { lat: 36.0, lng: 139.0 };
    const c = { lat: 35.002, lng: 139.0 };
    expect(splitSegments([a, b, far, c])).toEqual([[a, b]]);
    expect(splitSegments([])).toEqual([]);
  });
});

describe("date ranges", () => {
  it("computes a Monday-start week", () => {
    expect(getWeekRangeUTC("2026-10-30", 1)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });
  it("computes a month", () => {
    expect(getMonthRangeUTC("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("resolveLatestPosition", () => {
  const local = { lat: 1, lng: 1, ts: 200 };
  const server = { lat: 2, lng: 2, ts: 100 };
  it("prefers the newer of the local and server positions", () => {
    expect(resolveLatestPosition(local, server)).toEqual({ pos: local, preferLocal: true });
    expect(resolveLatestPosition({ ...local, ts: 50 }, server)).toEqual({ pos: server, preferLocal: false });
  });
  it("keeps the local position when the server's latest point has the same time", () => {
    expect(resolveLatestPosition(local, { ...server, ts: local.ts })).toEqual({ pos: local, preferLocal: true });
  });
  it("falls back to whichever exists", () => {
    expect(resolveLatestPosition(null, server)).toEqual({ pos: server, preferLocal: false });
    expect(resolveLatestPosition(local, null)).toEqual({ pos: local, preferLocal: true });
  });
});
