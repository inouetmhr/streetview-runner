/* Street View Runner + Web Bluetooth (FTMS) */
import { BLEWalker } from "./ble.js";
import { fetchStatus, appendHistory, fetchHistoryDay, getSession } from "./api.js";
import { createAuthUI } from "./auth-ui.js";
import { createHistoryView } from "./history-view.js";
import { createSpeedMeter } from "./speed-meter.js";
import { createVirtualRider } from "./virtual-rider.js";
import { createTrail } from "./trail.js";
import { createWakeLock } from "./wake-lock.js";
import { qs, MAP_ID, notify } from "./dom.js";
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
const SENSOR_CHIP_HIDE_MS = 3000; // show the sensor name briefly after connecting, then hide it

const MAPS_LOADER_TIMEOUT_MS = 15000;

// With loading=async the loader defines google.maps.importLibrary only once its own
// main script has loaded, which can be after this module starts, so wait for it.
async function waitForMapsLoader() {
  const deadline = Date.now() + MAPS_LOADER_TIMEOUT_MS;
  while (!window.google?.maps?.importLibrary) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// The Maps loader runs with loading=async, so classes are available only after importLibrary.
async function loadMapsLibraries() {
  if (!(await waitForMapsLoader())) {
    console.warn("Google Maps loader did not start");
    return false;
  }
  try {
    await Promise.all(["core", "maps", "streetView"].map((name) => google.maps.importLibrary(name)));
    return true;
  } catch (e) {
    console.warn("Google Maps libraries failed to load", e);
    return false;
  }
}

function initMap(start) {
  if (!window.google?.maps?.StreetViewPanorama) {
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

function getStartState(userId, statusResp) {
  const local = loadLastPosition(userId);
  if (!userId) statusResp = null;
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

  function setAuthToastVisible(show) {
    document.body.classList.toggle("auth-visible", show && !isHistoryOpen);
  }

  // Maps, the session, status and today's history do not depend on each other, so
  // load them together; status and history simply come back empty when signed out.
  const startDay = rideDay();
  const [mapsReady, initialUser, startStatus, startHistory] = await Promise.all([
    loadMapsLibraries(),
    getSession(),
    fetchStatus(startDay),
    fetchHistoryDay(startDay),
  ]);

  const auth = createAuthUI({
    initialUser,
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
  if (initialUser) auth.refreshPasskeys(); // side pane only; nothing waits for it

  // Map init: prefer server if newer; otherwise keep newer local position
  const initialStart = getStartState(currentUserId(), startStatus);
  let lastVisibilitySyncAt = Date.now();
  const last = initialStart.resolved.pos;
  if (mapsReady) [map, pano] = initMap(last || DEFAULT_LOCATION) || [];
  if (!map || !pano) {
    notify("Could not load the map. Check your connection and reload the page.", { kind: "error", sticky: true });
    return;
  }
  const trail = createTrail(map);
  const speedMeter = createSpeedMeter();
  const wakeLock = createWakeLock();
  // Keep the screen on while a sensor or the virtual rider is driving the ride.
  const updateWakeLock = () => wakeLock.set(!!walker.activeService || virtualRider.state.enabled);

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
    connectTitle: qs("connectTitle"),
    sensorChip: qs("sensorChip"),
    sensorChipText: qs("sensorChipText"),
    togglePane: qs("togglePane"),
    sideBackdrop: qs("sideBackdrop"),
    hudBar: qs("hudBar"),
    tapZone: qs("tapZone"),
    autoProgressLabel: qs("autoProgressLabel"),
    turnToast: qs("turnToast"),
    turnChoices: qs("turnChoices"),
    turnHint: qs("turnHint"),
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
      const [statusResp, historyData] = await Promise.all([fetchStatus(rideDay()), fetchHistoryDay(session.dayStr)]);
      const nextStart = getStartState(currentUserId(), statusResp);
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
      applyTodayHistory(historyData);
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
    deviceStatus.speed.textContent = metrics.speedKmh.toFixed(1);
    deviceStatus.cadence.textContent = Math.round(metrics.cadenceRpm);
    deviceStatus.distance.textContent = metrics.distanceM.toFixed(0);
    if (ble) {
      deviceStatus.deviceName.textContent = ble.device?.name || "Unknown";
      deviceStatus.serviceName.textContent = ble.activeService || "—";
    }
  }

  // Ride state (body[data-ride]): "idle" shows Connect under the HUD and Auto forward at
  // the bottom, "connecting" disables Connect, "connected" shows the sensor name at the
  // bottom and then hides it so nothing covers the view, "reconnecting" shows the chip
  // highlighted until the sensor is back or given up.
  let sensorChipTimer = 0;
  function setRideState(state, text = "") {
    document.body.dataset.ride = state;
    ui.connectBtn.disabled = state === "connecting";
    ui.connectTitle.textContent = state === "connecting" ? "Connecting…" : "Connect";
    ui.sensorChipText.textContent = text;
    ui.sensorChip.classList.remove("gone");
    clearTimeout(sensorChipTimer);
    if (state === "connected") {
      sensorChipTimer = setTimeout(() => ui.sensorChip.classList.add("gone"), SENSOR_CHIP_HIDE_MS);
    }
    console.log(`ride state: ${state}`);
  }
  const connectedText = () => `${walker.device?.name || "Sensor"} · Connected`;

  const walker = new BLEWalker();
  let prevSensorDistanceM = null;
  walker.onConnectionChange = (isConnected) => {
    setRideState(isConnected ? "connected" : "idle", isConnected ? connectedText() : "");
    if (isConnected) virtualRider.disable();
    updateWakeLock();
  };
  walker.onStatus = (text) => {
    if (document.body.dataset.ride === "reconnecting") ui.sensorChipText.textContent = text;
  };
  walker.onReconnect = (state) => {
    if (state === "reconnecting") {
      setRideState("reconnecting", "Reconnecting…");
      notify("Sensor disconnected. Reconnecting…", { kind: "error" });
    } else if (state === "reconnected") {
      notify("Sensor reconnected.");
    } else {
      notify("Sensor connection lost. Tap Connect to try again.", { kind: "error" });
    }
  };
  if (!navigator.bluetooth) ui.connectBtn.hidden = true; // Firefox, iOS: Auto forward only
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
    document.body.classList.toggle("auto-on", state.enabled);
    updateHudTitleVisibility(state.enabled ? state.speedKmh : 0);
    updateWakeLock();
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

  // ---------- Heading and turns ----------
  function setTurnBlocked(blocked, alert = false) {
    const changed = session.turnBlocked !== blocked;
    session.turnBlocked = blocked;
    if (ui.turnToast) ui.turnToast.style.display = blocked ? "block" : "none";
    if (blocked) renderTurnChoices();
    if (blocked && alert && changed) beep(180, 880);
  }

  // Roads available from here, relative to the travel heading (deg, negative = left).
  function turnOptions() {
    return (pano.getLinks() || [])
      .filter((link) => Number.isFinite(link.heading))
      .map((link) => ({ link, delta: angleDelta(session.travelHeading, link.heading) }));
  }

  // One arrow button per road, rotated to its direction, so a turn is a single tap.
  function renderTurnChoices() {
    if (!ui.turnChoices) return;
    const options = turnOptions();
    if (ui.turnHint) {
      ui.turnHint.textContent = options.length
        ? "Tap a direction or use the arrow keys"
        : "No road from here. Move the pegman on the mini map.";
    }
    const leftToRight = [...options].sort((a, b) => a.delta - b.delta);
    // Rebuild only when the choices change, so a tap in progress is not lost.
    const key = `${Math.round(session.travelHeading)}|${leftToRight.map((o) => o.link.pano).join(",")}`;
    if (ui.turnChoices.dataset.key === key) return;
    ui.turnChoices.dataset.key = key;
    ui.turnChoices.replaceChildren(...leftToRight.map(({ link, delta }) => {
      const btn = document.createElement("button");
      btn.className = "turn-choice";
      btn.title = link.description || `Turn ${Math.round(delta)}°`;
      btn.setAttribute("aria-label", `Turn ${delta < 0 ? "left" : "right"} ${Math.abs(Math.round(delta))} degrees`);
      const arrow = document.createElement("span");
      arrow.textContent = "↑";
      arrow.style.transform = `rotate(${delta}deg)`;
      btn.appendChild(arrow);
      btn.addEventListener("click", () => turnTo(link));
      return btn;
    }));
  }

  // Picks a road by arrow key while the turn prompt is up: ←/→ the nearest road on
  // that side, ↓ the one most behind (U-turn), ↑ the one closest to straight ahead.
  function pickTurnByKey(key) {
    const options = turnOptions();
    const byAbs = (a, b) => Math.abs(a.delta) - Math.abs(b.delta);
    let pick = null;
    if (key === "ArrowLeft") pick = options.filter((o) => o.delta < 0).sort(byAbs)[0];
    else if (key === "ArrowRight") pick = options.filter((o) => o.delta > 0).sort(byAbs)[0];
    else if (key === "ArrowDown") pick = options.sort(byAbs).at(-1);
    else if (key === "ArrowUp") pick = options.sort(byAbs)[0];
    return pick?.link || null;
  }

  function turnTo(link) {
    updateTravelHeading(link.heading);
    applyProgrammaticPov({ heading: link.heading, pitch: pano.getPov()?.pitch || 0 }, 700);
    if (session.distanceToGo > 0 && !session.turnBlocked) advance();
  }

  // Capture phase so Street View's own arrow-key handling does not also run.
  window.addEventListener("keydown", (e) => {
    if (!session.turnBlocked || isHistoryOpen || isEditableTarget(e.target)) return;
    const link = pickTurnByKey(e.key);
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    turnTo(link);
  }, true);

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
      setRideState("connecting");
      await walker.connect();
    } catch (e) {
      setRideState("idle");
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
      notify(finalMessage, { kind: "error" });
    }
  }
  ui.connectBtn?.addEventListener("click", doConnect);

  // Initialize today's distance from localStorage or server summary (when newer)
  session.dailyDistanceM = loadDailyDistance(currentUserId(), session.dayStr);
  applyServerDailyDistance(initialStart.statusResp, initialStart.resolved.preferLocal);
  renderDayKm();

  // Draw today's history as a trail on mini map (no distance calc)
  function applyTodayHistory(data) {
    try {
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
  if (auth.getUser()) applyTodayHistory(startHistory);
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
  // Side pane: hidden by default. History lives inside the pane, so closing the
  // pane also closes history and brings Street View back.
  function setSideOpen(open) {
    if (document.body.classList.contains("side-open") === open) return;
    if (!open) historyView.close();
    document.body.classList.toggle("side-open", open);
    ui.togglePane.textContent = open ? "×" : "☰";
    ui.togglePane.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    ui.togglePane.title = open ? "Close menu" : "Menu";
    ui.togglePane.setAttribute("aria-expanded", String(open));
    requestAnimationFrame(() => refreshPanoLayout());
  }
  ui.togglePane.addEventListener("click", () => setSideOpen(!document.body.classList.contains("side-open")));
  ui.sideBackdrop?.addEventListener("click", () => setSideOpen(false));
  document.addEventListener("keydown", (e) => {
    // Esc that cancelled an inline edit or closed the dialog does not also close the pane.
    if (e.key === "Escape" && !e.defaultPrevented && !qs("appDialog")?.open) setSideOpen(false);
  });
});
