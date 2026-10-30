/* Header speed estimate: windowed average smoothed by an EMA, decaying once movement stops */

const TAU_S = 5;     // EMA time constant (s)
const WINDOW_S = 5;  // averaging window (s)

export function createSpeedMeter({ tauS = TAU_S, windowS = WINDOW_S } = {}) {
  let smoothMps = 0;
  let lastAt = 0;  // ms of the last recorded movement
  let buffer = []; // { moved, ts } within the window

  const alphaFor = (dt) => 1 - Math.exp(-dt / tauS);

  return {
    // Records a movement of movedM meters at nowMs and returns the new speed in km/h.
    record(movedM, nowMs) {
      buffer.push({ moved: movedM, ts: nowMs });
      const cutoff = nowMs - windowS * 1000;
      while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift();
      if (lastAt > 0) {
        const dt = (nowMs - lastAt) / 1000;
        if (dt > 0 && buffer.length >= 2) {
          // The oldest entry only marks the window start, so its distance is excluded.
          const totalMoved = buffer.reduce((s, e) => s + e.moved, 0) - buffer[0].moved;
          const windowDt = (nowMs - buffer[0].ts) / 1000;
          const avgMps = windowDt > 0 ? totalMoved / windowDt : movedM / dt;
          smoothMps = alphaFor(dt) * avgMps + (1 - alphaFor(dt)) * smoothMps;
        } else if (dt > 0) {
          smoothMps = alphaFor(dt) * (movedM / dt) + (1 - alphaFor(dt)) * smoothMps;
        }
      }
      lastAt = nowMs;
      return this.kmh;
    },
    // Decays the speed toward 0 based on the time since the last movement.
    // Returns the new speed in km/h, or null when there was nothing to decay.
    decay(nowMs) {
      if (lastAt <= 0 || smoothMps <= 0) return null;
      const dt = (nowMs - lastAt) / 1000;
      smoothMps = (1 - alphaFor(dt)) * smoothMps;
      if (smoothMps < 0.01) smoothMps = 0;
      return this.kmh;
    },
    reset() {
      smoothMps = 0;
      lastAt = 0;
      buffer = [];
    },
    get kmh() {
      const v = smoothMps * 3.6;
      return Number.isFinite(v) ? v : 0;
    },
  };
}
