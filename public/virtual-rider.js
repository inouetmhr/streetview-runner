/* Virtual rider ("Auto forward"): feeds distance at a fixed speed when no sensor is connected */

const AUTO_SPEED_KMH = 15.0;
const VIRTUAL_STEP_M = 1.0;          // emit distance in steps of at least this much
const AUTO_STOP_MS = 3 * 60 * 1000;  // turn itself off after this long

/**
 * - onDistance(meters) receives each emitted step.
 * - onRender(state) runs whenever the displayed state changes.
 * - isSensorActive() returns true while a real sensor is connected; the rider then stops.
 */
export function createVirtualRider({ onDistance, onRender, isSensorActive }) {
  const state = { enabled: false, speedKmh: 0, distanceM: 0 };
  let pendingM = 0;
  let lastUpdateMs = performance.now();
  let autoStopTimer = null;
  let running = false;

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
    onRender(state);
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
    onRender(state);
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
    onRender(state);
  }

  return { toggle, disable, state };
}
