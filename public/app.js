/* Street View Runner + Web Bluetooth (FTMS) */
import { BLEWalker } from "./ble.js";
import { fetchStatus, appendHistory, fetchHistoryDay, getSession } from "./api.js";
import { createAuthUI } from "./auth-ui.js";
import { createHistoryView } from "./history-view.js";
import { createSpeedMeter } from "./speed-meter.js";
import { createVirtualRider } from "./virtual-rider.js";
import { createTrail } from "./trail.js";
import { qs, MAP_ID } from "./dom.js";
import {
  loadLastPosition,
  saveLastPosition,
  resolveLatestPosition,
  loadDailyDistance,
  saveDailyDistance,
} from "./ride-storage.js";
import {
  distMeters,
  angleDelta,
  blendHeading,
  stepHeadingToward,
  chooseForwardLink,
  rideDay,
} from "./geo.js";

const DEFAULT_LOCATION = { lat: 35.681296, lng: 139.758922, heading: 190 }; // Otemachi, Tokyo
const SENSOR_DISTANCE_SCALE = 0.9; // the sensor reports slightly too much distance
const TURN_BLOCK_ANGLE = 80;       // stop and ask the user to turn beyond this angle (deg)
const POV_ALIGN_MIN_ANGLE = 45;    // auto-align the view when it is off by more than this (deg)
const EXPLICIT_TURN_MIN_ANGLE = 30; // a view change this large is the user choosing a new direction (deg)
const MANUAL_JUMP_M = 20;          // larger moves are manual (pegman/link) jumps, not riding
const MAX_BACKLOG_M = 200;         // cap backlog in meters to avoid runaway
const HISTORY_SAVE_DISTANCE_M = 100;
const SPEED_DECAY_DELAY_MS = 5000; // start (and repeat) decaying this long after the last movement
const VISIBILITY_SYNC_MS = 60 * 1000;
const UNSUPPORTED_BLE_MESSAGE = "Web Bluetooth isn’t supported on Firefox or iOS.";

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
  const map = new google.maps.Map(qs("miniMap"), {
    center: pano.getPosition() || { lat: pos.lat, lng: pos.lng },
    zoom: 15,
    zoomControl: true,
    clickableIcons: false,
    mapId: MAP_ID,
  });
  map.setStreetView(pano);
  pano.addListener("position_changed", () => {
    const pos = pano.getPosition() || (pano.getLocation && pano.getLocation()?.latLng);
    if (pos) map.setCenter(pos);
  });
  return [map, pano];
}

async function getStartState(userId) {
  const local = loadLastPosition(userId);
  const statusResp = userId ? await fetchStatus(rideDay()) : null;
  const server = statusResp?.status || null;
  return { local, statusResp, resolved: resolveLatestPosition(local, server) };
}

function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea" || tag === "select";
}

function isTurnBlocked(pano, baseHeading) {
  const links = pano.getLinks() || [];
  if (!links.length) return true;
  const heading = Number.isFinite(baseHeading) ? baseHeading : (pano.getPov()?.heading || 0);
  return !links.some((link) => Math.abs(angleDelta(heading, link.heading || 0)) <= TURN_BLOCK_ANGLE);
}

// Simple beep using Web Audio for turn alerts
let audioCtx = null;
let lastBeepAt = 0;
function beep(durationMs = 200, freq = 880) {
  try {
    const now = performance.now();
    if (now - lastBeepAt < 250) return; // throttle beeps
    lastBeepAt = now;
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
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

  function setTapZoneVisible(show) {
    document.body.classList.toggle("tapzone-visible", show && !isHistoryOpen);
  }
  function setAuthToastVisible(show) {
    document.body.classList.toggle("auth-visible", show && !isHistoryOpen);
  }

  const auth = createAuthUI({
    initialUser: await getSession(),
    setAuthToastVisible,
    onBeforeLogout: () => {
      const pos = captureCurrentPosition();
      if (pos) saveLastPosition(null, pos);
    },
    onLogin: async (user, { wasAnonymous }) => {
      if (wasAnonymous) {
        const inherited = captureCurrentPosition() || loadLastPosition(null);
        if (inherited) saveLastPosition(user.userId, inherited);
      }
      session.ignoreNextHistorySave = true;
      await afterLogin();
      await historyView.refresh();
    },
  });
  const currentUserId = () => auth.getUser()?.userId;

  // Map init: prefer server if newer; otherwise keep newer local position
  const initialStart = await getStartState(currentUserId());
  let lastVisibilitySyncAt = Date.now();
  const last = initialStart.resolved.pos;
  [map, pano] = initMap(last || DEFAULT_LOCATION) || [];
  if (!map || !pano) return;
  const trail = createTrail(map);
  const speedMeter = createSpeedMeter();

  const session = {
    dailyDistanceM: 0,
    distanceToGo: 0,
    prevPosition: null,
    lastHistorySaved: null,
    turnBlocked: false,
    ignoreNextHistorySave: false,
    decayTimerId: 0,
    dayStr: rideDay(),
    travelHeading: Number.isFinite(last?.heading) ? last.heading : (pano.getPov()?.heading || DEFAULT_LOCATION.heading),
    ignorePovUntil: 0,
    pendingTravelHeadingTimerId: 0,
    pendingPovAdjustTimerId: 0,
  };

  const ui = {
    hdrSpeed: qs("hdrSpeed"),
    hdrDayKm: qs("hdrDayKm"),
    connectBtn: qs("connectBtn"),
    togglePane: qs("togglePane"),
    hudBar: qs("hudBar"),
    tapZone: qs("tapZone"),
    autoProgressLabel: qs("autoProgressLabel"),
    turnToast: qs("turnToast"),
  };
  const deviceStatus = {
    deviceName: qs("deviceName"),
    serviceName: qs("serviceName"),
    status: qs("status"),
    speed: qs("speed"),
    cadence: qs("cadence"),
    distance: qs("distance"),
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

  // ---------- Daily distance ----------
  function renderDayKm() {
    ui.hdrDayKm.textContent = (session.dailyDistanceM / 1000).toFixed(2);
  }

  function applyServerDailyDistance(statusResp, preferLocal) {
    const serverDay = statusResp?.day || session.dayStr;
    const serverDistanceM = statusResp?.dailyDistanceMeters;
    if (Number.isFinite(serverDistanceM) && serverDay === session.dayStr && !preferLocal) {
      session.dailyDistanceM = serverDistanceM;
      saveDailyDistance(currentUserId(), session.dayStr, session.dailyDistanceM);
      renderDayKm();
    }
  }

  function addDailyDistance(moved) {
    const currentDay = rideDay();
    if (currentDay !== session.dayStr) {
      // Day rolled over: switch accumulator to today's stored value
      session.dayStr = currentDay;
      session.dailyDistanceM = loadDailyDistance(currentUserId(), session.dayStr);
    }
    session.dailyDistanceM += moved;
    saveDailyDistance(currentUserId(), session.dayStr, session.dailyDistanceM);
    renderDayKm();
  }

  // ---------- Header speed ----------
  function updateHudTitleVisibility(speedKmh) {
    if (!ui.hudBar) return;
    const compact = Number.isFinite(speedKmh) && speedKmh > 0.1;
    ui.hudBar.classList.toggle("compact", compact);
  }

  function renderHeaderSpeed(speedKmh) {
    ui.hdrSpeed.textContent = speedKmh.toFixed(1);
    updateHudTitleVisibility(speedKmh);
  }

  // Decays the header speed once position_changed stops firing, repeating until it reaches 0.
  function decaySpeed() {
    const kmh = speedMeter.decay(Date.now());
    if (kmh == null) return;
    renderHeaderSpeed(kmh);
    if (kmh > 0) session.decayTimerId = setTimeout(decaySpeed, SPEED_DECAY_DELAY_MS);
  }

  function recordSpeed(moved) {
    renderHeaderSpeed(speedMeter.record(moved, Date.now()));
    clearTimeout(session.decayTimerId);
    session.decayTimerId = setTimeout(decaySpeed, SPEED_DECAY_DELAY_MS);
  }

  // After login tasks: refresh status and load today's history trail
  async function afterLogin() {
    try {
      const nextStart = await getStartState(currentUserId());
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

  // ---------- Sensor (BLE) and virtual rider ----------
  function renderMetrics(metrics, ble) {
    deviceStatus.speed.textContent = session.turnBlocked ? "Turn!" : metrics.speedKmh.toFixed(1);
    deviceStatus.cadence.textContent = Math.round(metrics.cadenceRpm);
    deviceStatus.distance.textContent = metrics.distanceM.toFixed(0);
    if (ble) {
      deviceStatus.deviceName.textContent = ble.device?.name || "Unknown";
      deviceStatus.serviceName.textContent = ble.activeService || "—";
    }
  }

  const walker = new BLEWalker();
  let prevSensorDistanceM = null;
  walker.onConnectionChange = (isConnected) => {
    ui.connectBtn.style.display = isConnected ? "none" : "";
    if (isConnected) virtualRider.disable();
    setTapZoneVisible(!isConnected);
  };
  walker.onData = () => {
    const total = walker.sensors.distanceM || 0;
    if (prevSensorDistanceM == null) prevSensorDistanceM = total;
    const delta = total - prevSensorDistanceM;
    prevSensorDistanceM = total;
    if (Number.isFinite(delta) && delta > 0) {
      onSensorDistanceDelta(delta * SENSOR_DISTANCE_SCALE);
    }
    renderMetrics(walker.sensors, walker);
  };

  function renderVirtualRider(state) {
    deviceStatus.speed.textContent = state.speedKmh.toFixed(1);
    deviceStatus.cadence.textContent = "0";
    deviceStatus.distance.textContent = state.distanceM.toFixed(0);
    deviceStatus.deviceName.textContent = "Virtual";
    deviceStatus.serviceName.textContent = "Auto progress";
    deviceStatus.status.textContent = state.enabled ? "Connected (Auto)" : "Idle (Auto off)";
    if (ui.autoProgressLabel) ui.autoProgressLabel.textContent = `Auto forward: ${state.enabled ? "On" : "Off"}`;
    updateHudTitleVisibility(state.enabled ? state.speedKmh : 0);
  }

  const virtualRider = createVirtualRider({
    onDistance: (m) => onSensorDistanceDelta(m),
    onRender: renderVirtualRider,
    isSensorActive: () => !!walker.activeService,
  });

  ui.tapZone?.addEventListener("pointerdown", (e) => {
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    virtualRider.toggle();
  });
  ui.tapZone?.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.code !== "Enter") return;
    e.preventDefault();
    virtualRider.toggle();
  });
  if (ui.autoProgressLabel) ui.autoProgressLabel.textContent = "Auto forward: Off";
  setTapZoneVisible(!walker.activeService);

  // ---------- Heading and turns ----------
  function setTurnBlocked(blocked, alert = false) {
    const changed = session.turnBlocked !== blocked;
    session.turnBlocked = blocked;
    if (ui.turnToast) ui.turnToast.style.display = blocked ? "block" : "none";
    if (blocked && alert && changed) beep(180, 880);
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

  function updateTravelHeading(nextHeading) {
    if (!Number.isFinite(nextHeading)) return;
    session.travelHeading = (nextHeading + 360) % 360;
    setTurnBlocked(isTurnBlocked(pano, session.travelHeading));
  }

  function scheduleTravelHeadingCommit(candidateHeading) {
    if (!Number.isFinite(candidateHeading)) return;
    if (Math.abs(angleDelta(session.travelHeading, candidateHeading)) < EXPLICIT_TURN_MIN_ANGLE) return;
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

  // ---------- Moving forward ----------
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
  function onSensorDistanceDelta(delta) {
    console.log(`onSensorDistanceDelta: ${delta} meter`);
    if (isNaN(delta) || delta <= 0.0) return; // not supposed
    session.distanceToGo = Math.min((session.distanceToGo || 0) + delta, MAX_BACKLOG_M);
    if (session.distanceToGo > 0) {
      advance();
    } else {
      console.log(`move skipped. backlog: ${session.distanceToGo.toFixed(1)}`);
    }
  }

  pano.addListener("links_changed", () => {
    const restToGo = session.distanceToGo;
    console.log(`links_changed. rest to go: ${restToGo.toFixed(1)}`);
    const blocked = isTurnBlocked(pano, session.travelHeading);
    setTurnBlocked(blocked, blocked);
    if (restToGo > 0 && !blocked) advance();
  });

  function saveHistoryIfMoved(currentPos, heading) {
    if (!auth.getUser()) return;
    if (session.ignoreNextHistorySave) {
      session.lastHistorySaved = { ...currentPos };
      session.ignoreNextHistorySave = false;
      return;
    }
    const historyChanged = !session.lastHistorySaved
      || distMeters(session.lastHistorySaved, currentPos) >= HISTORY_SAVE_DISTANCE_M;
    if (historyChanged) {
      session.lastHistorySaved = { ...currentPos };
      appendHistory({ ...currentPos, heading, ts: Date.now(), day: session.dayStr });
    }
  }

  // Called after links_changed event.
  pano.addListener("position_changed", () => {
    const loc = pano.getLocation();
    if (!loc || !loc.latLng) return;
    const currentPos = { lat: loc.latLng.lat(), lng: loc.latLng.lng() };
    const heading = pano.getPov()?.heading || 0;
    saveLastPosition(currentUserId(), { ...currentPos, heading });
    // Subtract actual moved distance from backlog
    let moved = 0;
    if (session.prevPosition) {
      moved = distMeters(session.prevPosition, currentPos);
      if (Number.isFinite(moved) && moved > 0) session.distanceToGo -= moved;
    }
    console.log("position_changed. moved:", moved.toFixed(1));
    if (moved < 0) return;
    if (moved > MANUAL_JUMP_M) { // reset when large changes caused by manual/pegman move on mini map.
      session.distanceToGo = 0;
      speedMeter.reset();
      session.prevPosition = currentPos;
      renderHeaderSpeed(0);
      return;
    }
    if (Number.isFinite(moved)) addDailyDistance(moved);
    recordSpeed(moved);
    if (session.prevPosition) trail.extend(session.prevPosition, currentPos);
    session.prevPosition = currentPos;
    // Persist history every HISTORY_SAVE_DISTANCE_M (status derives from history server-side)
    saveHistoryIfMoved(currentPos, heading);
  });

  // BLE controls (no explicit disconnect button per spec; disconnect via OS/BLE UI)
  async function doConnect() {
    try {
      deviceStatus.status.textContent = "Connecting…";
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
  }
  ui.connectBtn?.addEventListener("click", doConnect);

  // Initialize today's distance from localStorage or server summary (when newer)
  session.dailyDistanceM = loadDailyDistance(currentUserId(), session.dayStr);
  applyServerDailyDistance(initialStart.statusResp, initialStart.resolved.preferLocal);
  renderDayKm();

  // Load today's history and draw it as a trail on mini map (no distance calc)
  async function loadHistoryAndMarkers() {
    try {
      const data = await fetchHistoryDay(session.dayStr);
      if (!data?.ok) return;
      const items = Array.isArray(data.items) ? data.items : [];
      const points = items
        .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({ lat: p.lat, lng: p.lng }));
      trail.reset(points);
      // Set prev position to last point for subsequent movement tracking
      const lastPoint = points[points.length - 1];
      if (lastPoint) session.prevPosition = lastPoint;
    } catch {}
  }
  if (auth.getUser()) {
    await loadHistoryAndMarkers();
    await auth.refreshPasskeys();
  }
  setTurnBlocked(isTurnBlocked(pano, session.travelHeading));

  function refreshPanoLayout() {
    if (!window.google?.maps?.event) return;
    try { google.maps.event.trigger(pano, "resize"); } catch {}
    try {
      const pos = pano.getPosition();
      if (pos) pano.setPosition(pos);
      const pov = pano.getPov();
      if (pov) applyProgrammaticPov({ heading: pov.heading || 0, pitch: pov.pitch || 0, zoom: pov.zoom || 1 }, 300);
    } catch {}
  }
  // Side pane toggle: hidden by default; show with side-open on all screens
  ui.togglePane.addEventListener("click", () => {
    document.body.classList.toggle("side-open");
    requestAnimationFrame(() => refreshPanoLayout());
  });
});
