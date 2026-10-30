/* Street View Runner + Web Bluetooth (FTMS) */
import { BLEWalker } from "./ble.js";
import { fetchStatus, appendHistory, fetchHistoryDay, getSession } from "./api.js";
import { createAuthUI } from "./auth-ui.js";
import { createHistoryView } from "./history-view.js";
import {
  MAX_SEGMENT_M,
  distMeters,
  splitSegments,
  angleDelta,
  blendHeading,
  stepHeadingToward,
  chooseForwardLink,
  rideDay,
} from "./geo.js";

const DEFAULT_LOCATION = { lat: 35.681296, lng: 139.758922, heading: 190 }; // Otemachi, Tokyo
const MAP_ID = "fcf78f824472c3b8";
const SENSOR_DISTANCE_SCALE = 0.9; // the sensor reports slightly too much distance
const TURN_BLOCK_ANGLE = 80;       // stop and ask the user to turn beyond this angle (deg)
const POV_ALIGN_MIN_ANGLE = 45;    // auto-align the view when it is off by more than this (deg)
const MANUAL_JUMP_M = 20;          // larger moves are manual (pegman/link) jumps, not riding
const MAX_BACKLOG_M = 200;         // cap backlog in meters to avoid runaway

function qs(id) { return document.getElementById(id); }

function initMap(start) {
  if (!window.google || !google.maps) {
    console.warn("Google Maps API not available. Set GOOGLE_MAPS_API_KEY.");
    return null;
  }
  const el = qs("pano");
  const pos = (Number.isFinite(start?.lat) && Number.isFinite(start?.lng)) ? start : DEFAULT_LOCATION;
  const pano = new google.maps.StreetViewPanorama(el, {
    position: { lat: pos.lat, lng: pos.lng },
    pov: { heading: start?.heading ?? 165, pitch: 0 },
    zoom: 1,
    addressControl: true,
    addressControlOptions: { position: google.maps.ControlPosition.LEFT_BOTTOM },
    motionTracking: true,
    fullscreenControl: false,
    linksControl: true,
    showRoadLabels: true,
  });
  const map = new google.maps.Map(qs('miniMap'), {
    center: pano.getPosition() || { lat: pos.lat, lng: pos.lng },
    zoom: 15,
    zoomControl: true,
    clickableIcons: false,
    mapId: MAP_ID,
  });
  map.setStreetView(pano);
  pano.addListener('position_changed', () => {
    const pos = pano.getPosition() || (pano.getLocation && pano.getLocation()?.latLng);
    if (pos) map.setCenter(pos);
  });
  return [map, pano];
}

// Last known position persistence (localStorage), scoped per user
const lpKey = (userId) => `lastPosition:${userId || 'anon'}`;
function loadLastPositionFor(userId) {
  try {
    const raw = localStorage.getItem(lpKey(userId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Number.isFinite(data.lat) || !Number.isFinite(data.lng)) return null;
    return {
      lat: data.lat,
      lng: data.lng,
      heading: Number.isFinite(data.heading) ? data.heading : 0,
      ts: Number.isFinite(data.ts) ? data.ts : 0,
    };
  } catch { return null; }
}
function saveLastPositionFor(userId, pos) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
  const next = {
    lat: pos.lat,
    lng: pos.lng,
    heading: Number.isFinite(pos.heading) ? pos.heading : 0,
    ts: Number.isFinite(pos.ts) ? pos.ts : Date.now(),
  };
  try { localStorage.setItem(lpKey(userId), JSON.stringify(next)); } catch {}
}

function resolveLatestPosition(localPos, serverPos) {
  if (!localPos) return { pos: serverPos || null, preferLocal: false };
  if (!serverPos) return { pos: localPos, preferLocal: true };
  const localTs = Number.isFinite(localPos.ts) ? localPos.ts : 0;
  const serverTs = Number.isFinite(serverPos.ts) ? serverPos.ts : 0;
  const preferLocal = localTs > serverTs;
  return { pos: preferLocal ? localPos : serverPos, preferLocal };
}

async function getStartState(userId) {
  const local = loadLastPositionFor(userId);
  const statusResp = userId ? await fetchStatus(rideDay()) : null;
  const server = statusResp?.status || null;
  return { local, statusResp, resolved: resolveLatestPosition(local, server) };
}

window.addEventListener("DOMContentLoaded", async () => {
  let map = null;
  let pano = null;
  let isHistoryOpen = false;

  const captureCurrentPosition = () => {
    const pos = pano?.getPosition?.() || map?.getCenter?.();
    if (!pos) return null;
    const lat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
    const lng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const heading = pano?.getPov?.()?.heading;
    return { lat, lng, heading: Number.isFinite(heading) ? heading : 0 };
  };

  const auth = createAuthUI({
    initialUser: await getSession(),
    setAuthToastVisible,
    onBeforeLogout: () => {
      const pos = captureCurrentPosition();
      if (pos) saveLastPositionFor(null, pos);
    },
    onLogin: async (user, { wasAnonymous }) => {
      if (wasAnonymous) {
        const inherited = captureCurrentPosition() || loadLastPositionFor(null);
        if (inherited) saveLastPositionFor(user.userId, inherited);
      }
      session.ignoreNextHistorySave = true;
      await afterLogin();
      await historyView.refresh();
    },
  });

  // Map init: prefer server if newer; otherwise keep newer local position
  const initialStart = await getStartState(auth.getUser()?.userId);
  const VISIBILITY_SYNC_MS = 60 * 1000;
  let lastVisibilitySyncAt = Date.now();
  const last = initialStart.resolved.pos;
  [map, pano] = initMap(last || DEFAULT_LOCATION) || [];
  if (!map || !pano) return;

  const session = {
    dailyDistanceM: 0,
    distance_togo: 0,
    prevPosition: null,
    lastHistorySaved: null,
    turnBlocked: false,
    ignoreNextHistorySave: false,
    // For buffered EMA-smoothed header speed
    smoothSpeedMps: 0,           // smoothed speed in m/s
    lastPositionChangedAt: 0,    // timestamp (ms) of last position_changed
    speedBuffer: [],             // ring buffer of { moved, ts } for windowed avg
    decayTimerId: 0,             // setTimeout id for speed decay
    dayStr: rideDay(),
    travelHeading: Number.isFinite(last?.heading) ? last.heading : (pano.getPov()?.heading || DEFAULT_LOCATION.heading),
    ignorePovUntil: 0,
    pendingTravelHeading: null,
    pendingTravelHeadingTimerId: 0,
    pendingPovAdjustTimerId: 0,
  };

  const ui = {
    hdrSpeed: qs('hdrSpeed'),
    hdrDayKm: qs('hdrDayKm'),
    connectBtn: qs('connectBtn'),
    togglePane: qs('togglePane'),
  };
  const deviceStatus = {
    deviceName: qs('deviceName'),
    serviceName: qs('serviceName'),
    status: qs('status'),
    speed: qs('speed'),
    cadence: qs('cadence'),
    distance: qs('distance'),
  };

  const historyView = createHistoryView({
    getUser: auth.getUser,
    center: last || DEFAULT_LOCATION,
    onOpenChange: (open) => {
      isHistoryOpen = open;
      setAuthToastVisible(!auth.getUser());
      setTapZoneVisible(!walker.activeService);
    },
  });

  const applyServerDailyDistance = (statusResp, preferLocal) => {
    const serverDay = statusResp?.day || session.dayStr;
    const serverDistanceM = statusResp?.dailyDistanceMeters;
    if (Number.isFinite(serverDistanceM) && serverDay === session.dayStr && !preferLocal) {
      session.dailyDistanceM = serverDistanceM;
      saveDailyDistanceFor(session.dayStr, session.dailyDistanceM);
      ui.hdrDayKm.textContent = (session.dailyDistanceM / 1000).toFixed(2);
    }
  };

  // After login tasks: refresh status and load today's history trail
  async function afterLogin() {
    try {
      const nextStart = await getStartState(auth.getUser()?.userId);
      const next = nextStart.resolved.pos;
      if (next && Number.isFinite(next.lat) && Number.isFinite(next.lng)) {
        try {
          pano.setPosition({ lat: next.lat, lng: next.lng });
          if (Number.isFinite(next.heading)) {
            const pov = pano.getPov() || {};
            pov.heading = next.heading;
            pov.pitch = 0;
            applyProgrammaticPov(pov, 700);
            updateTravelHeading(next.heading);
          }
          session.prevPosition = { lat: next.lat, lng: next.lng };
        } catch {}
      }
      applyServerDailyDistance(nextStart.statusResp, nextStart.resolved.preferLocal);
      await loadHistoryAndMarkers();
    } catch {}
  }

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastVisibilitySyncAt < VISIBILITY_SYNC_MS) return;
    lastVisibilitySyncAt = now;
    if (!auth.getUser()) return;
    await afterLogin();
    await historyView.refresh();
  });

  function renderMetrics(metrics, ble) {
    if (session.turnBlocked) {
      deviceStatus.speed.textContent = 'Turn!';
    } else {
      deviceStatus.speed.textContent = metrics.speedKmh.toFixed(1);
    }
    deviceStatus.cadence.textContent = Math.round(metrics.cadenceRpm);
    deviceStatus.distance.textContent = metrics.distanceM.toFixed(0);
    if (ble) {
      deviceStatus.deviceName.textContent = ble.device?.name || 'Unknown';
      deviceStatus.serviceName.textContent = ble.activeService || '—';
    }
  }
  const hudBar = qs("hudBar");
  function updateHudTitleVisibility(speedKmh) {
    if (!hudBar) return;
    const compact = Number.isFinite(speedKmh) && speedKmh > 0.1;
    hudBar.classList.toggle("compact", compact);
  }

  function setConnectedUI(isConnected) {
    ui.connectBtn.style.display = isConnected ? 'none' : '';
  }


  const walker = new BLEWalker();
  walker.onConnectionChange = (isConnected) => {
    setConnectedUI(isConnected);
    if (isConnected) {
      disableAutoProgress();
    }
    setTapZoneVisible(!isConnected);
  };
  walker.onData = () => {
    const total = walker.sensors.distanceM || 0;
    if (walker.sensors.prevDistance == null) {
      walker.sensors.prevDistance = total;
    }
    const delta = total - walker.sensors.prevDistance;
    walker.sensors.prevDistance = total;
    if (Number.isFinite(delta) && delta > 0) {
      onSensorDistanceDelta(delta * SENSOR_DISTANCE_SCALE);
    }
    renderMetrics(walker.sensors, walker);
  };
  const virtual = {
    autoEnabled: false,
    speedKmh: 0,
    distanceM: 0,
    pendingM: 0,
    lastUpdateMs: performance.now(),
    autoStopTimer: null,
    running: false,
  };
  const AUTO_SPEED_KMH = 15.0;
  const VIRTUAL_STEP_M = 1.0;
  const AUTO_STOP_MS = 3 * 60 * 1000;
  const tapZone = qs("tapZone");
  const autoProgressLabel = qs("autoProgressLabel");
  function setTapZoneVisible(show) {
    document.body.classList.toggle("tapzone-visible", show && !isHistoryOpen);
  }
  function setAuthToastVisible(show) {
    document.body.classList.toggle("auth-visible", show && !isHistoryOpen);
  }

  function isEditableTarget(target) {
    const el = target;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || tag === "select";
  }

  function renderVirtualMetrics() {
    deviceStatus.speed.textContent = virtual.speedKmh.toFixed(1);
    deviceStatus.cadence.textContent = "0";
    deviceStatus.distance.textContent = virtual.distanceM.toFixed(0);
    deviceStatus.deviceName.textContent = "Virtual";
    deviceStatus.serviceName.textContent = "Auto progress";
    deviceStatus.status.textContent = virtual.autoEnabled ? "Connected (Auto)" : "Idle (Auto off)";
    updateHudTitleVisibility(virtual.autoEnabled ? virtual.speedKmh : 0);
  }

  function stepVirtualDistance(nowMs) {
    const dt = Math.max(0, (nowMs - virtual.lastUpdateMs) / 1000);
    virtual.lastUpdateMs = nowMs;
    if (walker.activeService) {
      disableAutoProgress();
      return;
    }
    if (!virtual.autoEnabled) return;
    virtual.speedKmh = AUTO_SPEED_KMH;
    const deltaM = (virtual.speedKmh * 1000 / 3600) * dt;
    if (deltaM > 0) {
      virtual.pendingM += deltaM;
      if (virtual.pendingM >= VIRTUAL_STEP_M) {
        const step = virtual.pendingM;
        virtual.pendingM = 0;
        virtual.distanceM += step;
        onSensorDistanceDelta(step);
      }
    }
    renderVirtualMetrics();
  }

  function runVirtualLoop() {
    if (!virtual.running) return;
    stepVirtualDistance(performance.now());
    if (!virtual.autoEnabled) {
      virtual.running = false;
      return;
    }
    requestAnimationFrame(runVirtualLoop);
  }

  function updateAutoProgressLabel() {
    if (!autoProgressLabel) return;
    autoProgressLabel.textContent = `Auto forward: ${virtual.autoEnabled ? "On" : "Off"}`;
  }

  function disableAutoProgress() {
    if (!virtual.autoEnabled) return;
    virtual.autoEnabled = false;
    virtual.speedKmh = 0;
    virtual.pendingM = 0;
    if (virtual.autoStopTimer) {
      clearTimeout(virtual.autoStopTimer);
      virtual.autoStopTimer = null;
    }
    updateAutoProgressLabel();
    renderVirtualMetrics();
  }

  function toggleAutoProgress() {
    if (walker.activeService) return;
    if (virtual.autoEnabled) {
      disableAutoProgress();
      return;
    }
    virtual.autoEnabled = true;
    virtual.speedKmh = AUTO_SPEED_KMH;
    if (virtual.autoStopTimer) clearTimeout(virtual.autoStopTimer);
    virtual.autoStopTimer = setTimeout(() => {
      disableAutoProgress();
    }, AUTO_STOP_MS);
    if (!virtual.running) {
      virtual.running = true;
      virtual.lastUpdateMs = performance.now();
      requestAnimationFrame(runVirtualLoop);
    }
    updateAutoProgressLabel();
    renderVirtualMetrics();
  }

  tapZone?.addEventListener("pointerdown", (e) => {
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    toggleAutoProgress();
  });
  tapZone?.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.code !== "Enter") return;
    e.preventDefault();
    toggleAutoProgress();
  });
  updateAutoProgressLabel();
  setTapZoneVisible(!walker.activeService);
  // Simple beep using Web Audio for turn alerts
  let audioCtx = null;
  let lastBeepAt = 0;
  function beep(durationMs = 200, freq = 880) {
    try {
      const now = performance.now();
      if (now - lastBeepAt < 250) return; // throttle beeps
      lastBeepAt = now;
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
      o.start();
      o.stop(t0 + durationMs / 1000 + 0.02);
    } catch {}
  }
  
  const turnToast = qs('turnToast');
  function showTurnToast(show) {
    if (!turnToast) return;
    const next = show ? 'block' : 'none';
    if (turnToast.style.display === next) return; // no-op if unchanged
    turnToast.style.display = next;
  }

  function setTurnBlocked(blocked, alert = false) {
    const changed = session.turnBlocked !== blocked;
    session.turnBlocked = blocked;
    showTurnToast(blocked);
    if (blocked && alert && changed) {
      beep(180, 880);
    }
  }

  function applyProgrammaticPov(nextPov, suppressMs = 500) {
    clearTimeout(session.pendingTravelHeadingTimerId);
    session.ignorePovUntil = Date.now() + suppressMs;
    pano.setPov(nextPov);
  }

  function schedulePovAdjustment(targetHeading, delayMs = 150) {
    if (!Number.isFinite(targetHeading)) return;
    clearTimeout(session.pendingPovAdjustTimerId);
    session.pendingPovAdjustTimerId = setTimeout(() => {
      const pov = pano.getPov();
      const currentHeading = pov?.heading || 0;
      const viewTurnAngle = Math.abs(angleDelta(currentHeading, targetHeading));
      if (viewTurnAngle <= POV_ALIGN_MIN_ANGLE) return;
      const nextViewHeading = stepHeadingToward(currentHeading, targetHeading, 20);
      applyProgrammaticPov({ heading: nextViewHeading, pitch: pov?.pitch || 0 }, 700);
    }, delayMs);
  }

  function isTurnBlocked(pano, baseHeading) {
    const links = pano.getLinks() || [];
    if (!links.length) return true;
    const heading = Number.isFinite(baseHeading) ? baseHeading : (pano.getPov()?.heading || 0);
    return !links.some((link) => Math.abs(angleDelta(heading, link.heading || 0)) <= TURN_BLOCK_ANGLE);
  }

  function updateTravelHeading(nextHeading) {
    if (!Number.isFinite(nextHeading)) return;
    session.travelHeading = (nextHeading + 360) % 360;
    setTurnBlocked(isTurnBlocked(pano, session.travelHeading));
  }

  function scheduleTravelHeadingCommit(candidateHeading) {
    if (!Number.isFinite(candidateHeading)) return;
    const EXPLICIT_TURN_MIN_ANGLE = 30;
    if (Math.abs(angleDelta(session.travelHeading, candidateHeading)) < EXPLICIT_TURN_MIN_ANGLE) return;
    session.pendingTravelHeading = candidateHeading;
    clearTimeout(session.pendingTravelHeadingTimerId);
    session.pendingTravelHeadingTimerId = setTimeout(() => {
      const settledHeading = pano.getPov()?.heading;
      if (!Number.isFinite(settledHeading)) return;
      if (Math.abs(angleDelta(session.travelHeading, settledHeading)) < EXPLICIT_TURN_MIN_ANGLE) return;
      updateTravelHeading(settledHeading);
    }, 300);
  }

  pano.addListener("pov_changed", () => {
    const heading = pano.getPov()?.heading;
    if (!Number.isFinite(heading)) return;
    if (Date.now() < session.ignorePovUntil) return;
    scheduleTravelHeadingCommit(heading);
  });

  function advance() {
    const baseHeading = session.travelHeading;
    const link = chooseForwardLink(pano, baseHeading);
    if (!link) return;
    const pov = pano.getPov();
    const turnAngle = Math.abs(angleDelta(baseHeading, link.heading || 0));
    if (turnAngle > TURN_BLOCK_ANGLE) {
      console.log("turn blocked. angle: " + turnAngle);
      setTurnBlocked(true, true);
      return;
    }
    setTurnBlocked(false);
    updateTravelHeading(blendHeading(session.travelHeading, link.heading || baseHeading, 0.2));
    pano.setPano(link.pano);
    schedulePovAdjustment(link.heading || pov.heading || 0, 150);
  }
  window.advance = advance; // for debug

  /* Moves forward by the delta [meter].
     The actual movement is performed by advance(), and how much progress is made depends on Maps,
     so the result can only be inferred.
     Therefore, advance() is repeatedly called for the remaining distance to travel. */
  function onSensorDistanceDelta(delta){
    console.log(`onSensorDistanceDelta: ${delta} meter`);
    if (isNaN(delta) || delta <= 0.0)  return; // not supposed
    session.distance_togo = Math.min((session.distance_togo || 0) + delta, MAX_BACKLOG_M);
    if (session.distance_togo > 0) {
      advance();
    } else {
      console.log(`move skipped. backlog: ${session.distance_togo.toFixed(1)}`);
    }
  }

  pano.addListener("links_changed", () => {
    const rest_togo = session.distance_togo;
    console.log(`links_changed. rest to go: ${rest_togo.toFixed(1)}`);
    const blocked = isTurnBlocked(pano, session.travelHeading);
    setTurnBlocked(blocked, blocked);
    if (rest_togo > 0 && !blocked) {
      advance();
    }
  });

  // Called after links_changed event.
  pano.addListener("position_changed", () => {
    const loc = pano.getLocation();
    if (!loc || !loc.latLng) return;
    const currentPos = { lat: loc.latLng.lat(), lng: loc.latLng.lng() };
    const heading = pano.getPov()?.heading || 0;
    saveLastPositionFor(auth.getUser()?.userId, { ...currentPos, heading });
    // Subtract actual moved distance from backlog
    let moved = 0;
    if (session.prevPosition) {
      moved = distMeters(session.prevPosition, currentPos);
      if (Number.isFinite(moved) && moved > 0) {
        session.distance_togo -= moved;
      }
    }
    console.log("position_changed. moved:", moved.toFixed(1));
    if (moved < 0) return;
    if (moved > MANUAL_JUMP_M) { // reset when large changes caused by manual/pegman move on mini map.
      session.distance_togo = 0;
      session.smoothSpeedMps = 0;
      session.lastPositionChangedAt = 0;
      session.speedBuffer = [];
      session.prevPosition = currentPos;
      ui.hdrSpeed.textContent = "0.0";
      updateHudTitleVisibility(0);
      return;
    }
    // Daily distance: persist locally by day
    const currentDay = dayString();
    if (currentDay !== session.dayStr) {
      // Day rolled over: switch accumulator to today's stored value
      session.dayStr = currentDay;
      session.dailyDistanceM = loadDailyDistanceFor(session.dayStr);
    }
    if (Number.isFinite(moved) && moved >= 0) {
      session.dailyDistanceM += moved;
      saveDailyDistanceFor(session.dayStr, session.dailyDistanceM);
      ui.hdrDayKm.textContent = (session.dailyDistanceM / 1000).toFixed(2);
    }
    // Update header speed using windowed-average + EMA
    const now = Date.now();
    const TAU = 5;          // EMA time constant in seconds
    const WINDOW = 5;       // buffer window in seconds
    // Add to ring buffer and trim old entries
    session.speedBuffer.push({ moved, ts: now });
    const cutoff = now - WINDOW * 1000;
    while (session.speedBuffer.length > 0 && session.speedBuffer[0].ts < cutoff) {
      session.speedBuffer.shift();
    }
    if (session.lastPositionChangedAt > 0) {
      const dt = (now - session.lastPositionChangedAt) / 1000;
      if (dt > 0 && session.speedBuffer.length >= 2) {
        // Windowed average speed: exclude oldest entry's moved (it's the window start marker)
        const totalMoved = session.speedBuffer.reduce((s, e) => s + e.moved, 0) - session.speedBuffer[0].moved;
        const windowDt = (now - session.speedBuffer[0].ts) / 1000;
        const avgSpeed = windowDt > 0 ? totalMoved / windowDt : moved / dt;
        const alpha = 1 - Math.exp(-dt / TAU);
        session.smoothSpeedMps = alpha * avgSpeed + (1 - alpha) * session.smoothSpeedMps;
      } else if (dt > 0) {
        // Only 1 sample: fall back to instant speed
        const alpha = 1 - Math.exp(-dt / TAU);
        session.smoothSpeedMps = alpha * (moved / dt) + (1 - alpha) * session.smoothSpeedMps;
      }
    }
    session.lastPositionChangedAt = now;
    const speedKmh = session.smoothSpeedMps * 3.6;
    ui.hdrSpeed.textContent = (Number.isFinite(speedKmh) ? speedKmh : 0).toFixed(1);
    updateHudTitleVisibility(speedKmh);
    // Reset decay timer so it starts exactly 5s after last movement
    clearTimeout(session.decayTimerId);
    session.decayTimerId = setTimeout(scheduleSpeedDecay, 5000);

    if (session.prevPosition) extendTrail(session.prevPosition, currentPos);
    session.prevPosition = currentPos;
    // Persist history every HISTORY_SAVE_DISTANCE_M (status derives from history server-side)
    const HISTORY_SAVE_DISTANCE_M = 100;
    if (auth.getUser()) {
      if (session.ignoreNextHistorySave) {
        session.lastHistorySaved = { ...currentPos };
        session.ignoreNextHistorySave = false;
      } else {
        const historyChanged = !session.lastHistorySaved
          || distMeters(session.lastHistorySaved, currentPos) >= HISTORY_SAVE_DISTANCE_M;
        if (historyChanged) {
          session.lastHistorySaved = { ...currentPos };
          appendHistory({ ...currentPos, heading, ts: Date.now(), day: session.dayStr });
        }
      }
    }
  });

  // Decay: smoothly reduce speed toward 0 when position_changed stops firing.
  // Triggered 5s after last movement, then repeats every 5s until speed reaches 0.
  function scheduleSpeedDecay() {
    const TAU = 5;
    const now = Date.now();
    if (session.lastPositionChangedAt > 0 && session.smoothSpeedMps > 0) {
      const dt = (now - session.lastPositionChangedAt) / 1000;
      const alpha = 1 - Math.exp(-dt / TAU);
      session.smoothSpeedMps = (1 - alpha) * session.smoothSpeedMps;
      if (session.smoothSpeedMps < 0.01) session.smoothSpeedMps = 0;
      const speedKmh = session.smoothSpeedMps * 3.6;
      ui.hdrSpeed.textContent = (Number.isFinite(speedKmh) ? speedKmh : 0).toFixed(1);
      updateHudTitleVisibility(speedKmh);
      // Continue decaying if not yet zero
      if (session.smoothSpeedMps > 0) {
        session.decayTimerId = setTimeout(scheduleSpeedDecay, 5000);
      }
    }
  }

  // BLE controls
  const UNSUPPORTED_BLE_MESSAGE = "Web Bluetooth isn’t supported on Firefox or iOS.";
  const doConnect = async () => {
    try {
      deviceStatus.status.textContent = 'Connecting…';
      await walker.connect();
    } catch (e) {
      const message = String(e?.message || e);
      if (e?.name === "NotFoundError") {
        deviceStatus.status.textContent = message;
        return;
      }
      const isUnsupported = e?.name === "NotSupportedError"
        || /not supported/i.test(message)
        || (e instanceof TypeError && /bluetooth|requestdevice/i.test(message));
      const finalMessage = isUnsupported ? UNSUPPORTED_BLE_MESSAGE : message;
      deviceStatus.status.textContent = finalMessage;
      alert(finalMessage);
    }
  };
  if (ui.connectBtn) ui.connectBtn.addEventListener('click', doConnect);
  // No explicit disconnect button per spec; disconnect via OS/BLE UI

  // Daily distance persistence (localStorage), scoped per user
  const ddKey = (dStr) => `dailyDistance:${auth.getUser()?.userId || 'anon'}:${dStr}`;
  const loadDailyDistanceFor = (dStr) => {
    const v = parseFloat(localStorage.getItem(ddKey(dStr)) ?? '');
    return Number.isFinite(v) ? v : 0;
  };
  const saveDailyDistanceFor = (dStr, val) => {
    try { localStorage.setItem(ddKey(dStr), String(val)); } catch {}
  };
  // Initialize today's distance from localStorage or server summary (when newer)
  session.dailyDistanceM = loadDailyDistanceFor(session.dayStr);
  applyServerDailyDistance(initialStart.statusResp, initialStart.resolved.preferLocal);
  ui.hdrDayKm.textContent = (session.dailyDistanceM/1000).toFixed(2);

  // Load today's history and draw it as a trail on mini map (no distance calc)
  async function loadHistoryAndMarkers() {
    try {
      const data = await fetchHistoryDay(session.dayStr);
      if (!data?.ok) return;
      const items = Array.isArray(data.items) ? data.items : [];
      const points = items
        .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({ lat: p.lat, lng: p.lng }));
      resetTrail(points);
      // Set prev position to last point for subsequent movement tracking
      const last = points[points.length - 1];
      if (last) session.prevPosition = last;
    } catch {}
  }
  if (auth.getUser()) await loadHistoryAndMarkers();
  if (auth.getUser()) await auth.refreshPasskeys();
  setTurnBlocked(isTurnBlocked(pano, session.travelHeading));
  function refreshPanoLayout() {
    if (!pano || !window.google?.maps?.event) return;
    try { google.maps.event.trigger(pano, "resize"); } catch {}
    try {
      const pos = pano.getPosition();
      if (pos) pano.setPosition(pos);
      const pov = pano.getPov();
      if (pov) applyProgrammaticPov({ heading: pov.heading || 0, pitch: pov.pitch || 0, zoom: pov.zoom || 1 }, 300);
    } catch {}
  }
  // Side pane toggle: hidden by default; show with side-open on all screens
  ui.togglePane.addEventListener('click', () => {
    document.body.classList.toggle('side-open');
    requestAnimationFrame(() => refreshPanoLayout());
  });

  // Mini map trail: a few polylines instead of one marker per step,
  // so long rides keep a bounded number of map objects.
  let trailPolylines = [];
  function newTrailPolyline(path) {
    const pl = new google.maps.Polyline({
      path,
      strokeColor: "#2563eb",
      strokeOpacity: 0.8,
      strokeWeight: 4,
      clickable: false,
      map,
    });
    trailPolylines.push(pl);
    return pl;
  }
  function resetTrail(points) {
    trailPolylines.forEach((pl) => pl.setMap(null));
    trailPolylines = [];
    for (const path of splitSegments(points)) newTrailPolyline(path);
  }
  function extendTrail(from, to) {
    const TRAIL_JOIN_M = 1;
    const last = trailPolylines[trailPolylines.length - 1];
    const path = last?.getPath();
    const tail = path && path.getLength() ? path.getAt(path.getLength() - 1) : null;
    const tailPos = tail ? { lat: tail.lat(), lng: tail.lng() } : null;
    if (tailPos && distMeters(tailPos, from) <= TRAIL_JOIN_M && distMeters(from, to) <= MAX_SEGMENT_M) {
      path.push(new google.maps.LatLng(to.lat, to.lng));
    } else {
      newTrailPolyline([from, to]);
    }
  }
});
