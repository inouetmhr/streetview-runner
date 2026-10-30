import { describe, it, expect } from "vitest";
import {
  isValidDayString,
  isPlausibleRideDay,
  isPlausibleTs,
  isValidLatLng,
  normalizeHistoryRange,
  summarizeHistory,
  toBase64URL,
  fromBase64URL,
  getCookie,
} from "../lib.js";

describe("isValidDayString", () => {
  it("accepts real calendar days", () => {
    expect(isValidDayString("2026-02-28")).toBe(true);
    expect(isValidDayString("2024-02-29")).toBe(true);
  });
  it("rejects malformed or impossible days", () => {
    expect(isValidDayString("2026-02-30")).toBe(false);
    expect(isValidDayString("2026-2-3")).toBe(false);
    expect(isValidDayString("")).toBe(false);
    expect(isValidDayString(undefined)).toBe(false);
  });
});

describe("isPlausibleRideDay", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  it("accepts the server day and ±1 day", () => {
    expect(isPlausibleRideDay("2026-10-29", now)).toBe(true);
    expect(isPlausibleRideDay("2026-10-30", now)).toBe(true);
    expect(isPlausibleRideDay("2026-10-31", now)).toBe(true);
  });
  it("rejects days further away", () => {
    expect(isPlausibleRideDay("2026-10-28", now)).toBe(false);
    expect(isPlausibleRideDay("2026-11-01", now)).toBe(false);
  });
});

describe("isPlausibleTs / isValidLatLng", () => {
  it("bounds timestamps to a day of skew", () => {
    const now = 1_800_000_000_000;
    expect(isPlausibleTs(now - 60_000, now)).toBe(true);
    expect(isPlausibleTs(now - 2 * 86_400_000, now)).toBe(false);
    expect(isPlausibleTs(NaN, now)).toBe(false);
  });
  it("checks coordinate ranges", () => {
    expect(isValidLatLng(35.68, 139.76)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, -181)).toBe(false);
  });
});

describe("normalizeHistoryRange", () => {
  it("fills a missing side and keeps order", () => {
    expect(normalizeHistoryRange("2026-10-01", "")).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(normalizeHistoryRange("2026-10-02", "2026-10-01")).toBeNull();
  });
  it("allows a full 31-day month but not 32 days", () => {
    expect(normalizeHistoryRange("2026-10-01", "2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(normalizeHistoryRange("2026-10-01", "2026-11-01")).toBeNull();
  });
});

describe("summarizeHistory", () => {
  it("sums segments and skips warps over 500 m", () => {
    const items = [
      { lat: 35.0, lng: 139.0 },
      { lat: 35.001, lng: 139.0 }, // ~111 m
      { lat: 35.1, lng: 139.0 },   // ~11 km warp, excluded
      { lat: 35.101, lng: 139.0 }, // ~111 m
    ];
    const { distanceMeters, count } = summarizeHistory(items);
    expect(count).toBe(4);
    expect(distanceMeters).toBeGreaterThan(220);
    expect(distanceMeters).toBeLessThan(225);
  });
  it("returns 0 for fewer than two points", () => {
    expect(summarizeHistory([{ lat: 0, lng: 0 }])).toEqual({ distanceMeters: 0, movingSeconds: 0, count: 1 });
  });
});

describe("base64url and cookies", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const s = toBase64URL(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...fromBase64URL(s)]).toEqual([...bytes]);
  });
  it("reads cookie values containing '='", () => {
    const req = new Request("https://x.test/", { headers: { cookie: "a=1; svr_session=ab=c" } });
    expect(getCookie(req, "svr_session")).toBe("ab=c");
    expect(getCookie(req, "missing")).toBeNull();
  });
});

describe("summarizeHistory moving time and days", () => {
  const MIN = 60 * 1000;
  // ~111 m per 0.001° of latitude
  const pt = (day, i, tsMin) => ({ day, lat: 35 + i * 0.001, lng: 139, ts: tsMin * MIN });

  it("counts gaps up to 5 minutes as riding and longer ones as breaks", () => {
    const s = summarizeHistory([{ lat: 35, lng: 139, ts: 0 }, { lat: 35.001, lng: 139, ts: 1 * MIN }, { lat: 35.002, lng: 139, ts: 30 * MIN }]);
    expect(s.movingSeconds).toBe(60);
    expect(s.distanceMeters).toBeGreaterThan(220);
    expect(s.days).toBeUndefined();
  });

  it("splits by day and never joins the last point of one day to the next", () => {
    const s = summarizeHistory([pt("2026-10-29", 0, 0), pt("2026-10-29", 1, 1), pt("2026-10-30", 2, 2), pt("2026-10-30", 3, 3)]);
    expect(s.days.map((d) => d.day)).toEqual(["2026-10-29", "2026-10-30"]);
    expect(s.days.every((d) => d.movingSeconds === 60 && d.count === 2)).toBe(true);
    expect(s.distanceMeters).toBeCloseTo(s.days[0].distanceMeters + s.days[1].distanceMeters);
    expect(s.distanceMeters).toBeLessThan(250); // the cross-day segment is not counted
  });
});
