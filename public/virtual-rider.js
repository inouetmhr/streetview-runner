/* Virtual rider ("Auto forward"): feeds distance at a fixed speed when no sensor is connected */

const AUTO_SPEED_KMH = 15.0;
const VIRTUAL_STEP_M = 1.0;          // emit distance in steps of at least this much
const AUTO_STOP_MS = 3 * 60 * 1000;  // turn itself off after this long
const RENDER_INTERVAL_MS = 250;      // the display only needs a few updates per second

/**
 * - onDistance(meters) receives each emitted step.
 * - onRender(state) runs on every on/off change and up to 4 times a second while riding.
 * - isSensorActive() returns true while a real sensor is connected; the rider then stops.
 */
export function createVirtualRider({ onDistance, onRender, isSensorActive }) {
  const state = { enabled: false, speedKmh: 0, distanceM: 0 };
  let pendingM = 0;
  let lastUpdateMs = performance.now();
  let autoStopTimer = null;
  let running = false;
  let lastRenderMs = 0;

  // Renders at most every RENDER_INTERVAL_MS while riding; `force` for on/off changes.
  function render(nowMs, force = false) {
    if (!force && nowMs - lastRenderMs < RENDER_INTERVAL_MS) return;
    lastRenderMs = nowMs;
    onRender(state);
  }

  function step(nowMs) {
    const dt = Math.max(0, (nowMs - lastUpdateMs) / 1000);
    lastUpdateMs = nowMs;
    if (isSensorActive()) {
      disable();
      return;
    }
    if (!state.enabled) return;
    state.speedKmh = AUTO_SPEED_KMH;
    const deltaM = (state.speedKmh * 1000 / 3600) * dt;
    if (deltaM > 0) {
      pendingM += deltaM;
      if (pendingM >= VIRTUAL_STEP_M) {
        const stepM = pendingM;
        pendingM = 0;
        state.distanceM += stepM;
        onDistance(stepM);
      }
    }
    render(nowMs);
  }

  function loop() {
    if (!running) return;
    step(performance.now());
    if (!state.enabled) {
      running = false;
      return;
    }
    requestAnimationFrame(loop);
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    state.speedKmh = 0;
    pendingM = 0;
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
    render(performance.now(), true);
  }

  function toggle() {
    if (isSensorActive()) return;
    if (state.enabled) {
      disable();
      return;
    }
    state.enabled = true;
    state.speedKmh = AUTO_SPEED_KMH;
    if (autoStopTimer) clearTimeout(autoStopTimer);
    autoStopTimer = setTimeout(disable, AUTO_STOP_MS);
    if (!running) {
      running = true;
      lastUpdateMs = performance.now();
      requestAnimationFrame(loop);
    }
    render(performance.now(), true);
  }

  return { toggle, disable, state };
}
