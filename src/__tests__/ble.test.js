import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseIndoorBikeData, BLEWalker } from "../../public/ble.js";

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

describe("BLEWalker reconnect", () => {
  // Fake GATT device: connect() fails `failures` times, then succeeds with an FTMS service.
  function fakeDevice(failures) {
    const listeners = {};
    const device = {
      name: "Bike",
      connects: 0,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      drop: () => listeners.gattserverdisconnected(),
      gatt: {
        connect: async () => {
          device.connects++;
          if (device.connects > 1 && failures-- > 0) throw new Error("out of range");
          return {
            getPrimaryService: async () => ({
              getCharacteristic: async () => ({ addEventListener() {}, startNotifications: async () => {} }),
            }),
          };
        },
        disconnect() {},
      },
    };
    return device;
  }

  async function connected(device) {
    vi.stubGlobal("document", { getElementById: () => ({ textContent: "" }) });
    vi.stubGlobal("navigator", { bluetooth: { requestDevice: async () => device } });
    const walker = new BLEWalker();
    const events = [];
    walker.onConnectionChange = (c) => events.push(c ? "up" : "down");
    walker.onReconnect = (s) => events.push(s);
    await walker.connect();
    return { walker, events };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("reconnects to the same device after a dropout", async () => {
    const device = fakeDevice(2);
    const { walker, events } = await connected(device);
    device.drop();
    expect(walker.activeService).toBeNull();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(walker.activeService).toBe("FTMS");
    expect(events).toEqual(["up", "reconnecting", "up", "reconnected"]);
  });

  it("gives up after the last retry and reports a disconnect", async () => {
    const device = fakeDevice(99);
    const { walker, events } = await connected(device);
    device.drop();
    await vi.advanceTimersByTimeAsync(31000);
    expect(walker.activeService).toBeNull();
    expect(events).toEqual(["up", "reconnecting", "failed", "down"]);
  });

  it("stops retrying when the user disconnects", async () => {
    const device = fakeDevice(99);
    const { walker, events } = await connected(device);
    device.drop();
    await walker.disconnect();
    await vi.advanceTimersByTimeAsync(31000);
    expect(device.connects).toBe(1);
    expect(events).toEqual(["up", "reconnecting", "down"]);
  });
});
