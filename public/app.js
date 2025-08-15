/* Street View Runner + Web Bluetooth (FTMS) */

function qs(id) { return document.getElementById(id); }

class Metrics {
  constructor() {
    this.speedKmh = 0; // km/h
    this.cadenceRpm = 0; // rpm
    this.distanceM = 0; // meters
    this.prevDistance = null;
  }
}

class BLEWalker {
  constructor() {
    this.device = null;
    this.server = null;
    this.onData = null; // () => void; consumer reads this.metrics/this
    this.sensors = new Metrics();
    this._activeService = null; // 'FTMS' | null
    this.onConnectionChange = null; // (isConnected:boolean) => void
  }
  get activeService() { return this._activeService; }
  async connect() {
    const options = {
      // Restrict to FTMS devices only
      filters: [{ services: [0x1826] }],
      optionalServices: [0x1826],
    };
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    this.server = await this.device.gatt.connect();
    // Only FTMS is supported
    if (await this._tryFTMS()) return;
    this._status('Connected (no FTMS service)');
    try { this.onConnectionChange?.(false); } catch {}
  }
  async disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
    this._onDisconnected();
  }
  _onDisconnected() {
    this._activeService = null;
    this.device = null;
    this.server = null;
    this._status('Disconnected');
    try { this.onConnectionChange?.(false); } catch {}
  }
  _status(s) {
    qs('status').textContent = s;
  }
  async _tryFTMS() {
    try {
      const svc = await this.server.getPrimaryService(0x1826);
      const indoorBikeDataUUID = 0x2ad2; // Indoor Bike Data
      const ch = await svc.getCharacteristic(indoorBikeDataUUID);
      ch.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        this._onFTMS(dv);
        try { this.onData?.(); } catch {}
      });
      await ch.startNotifications();
      this._activeService = 'FTMS';
      this._status('Connected (FTMS: Indoor Bike)');
      try { this.onConnectionChange?.(true); } catch {}
      return true;
    } catch { return false; }
  }
  _onFTMS(dv) {
    const data = this._parseIndoorBikeData(dv);
    if (data.instantaneous_cadence) {
      this.sensors.cadenceRpm = Math.round(data.instantaneous_cadence);
    }
    if (data.instantaneous_speed) {
      this.sensors.speedKmh = data.instantaneous_speed
    }
    if (data.total_distance != null) {
      this.sensors.distanceM = data.total_distance;
    }
  }
  
  _parseIndoorBikeData(dataView) {
    //SPEC: https://btprodspecificationrefs.blob.core.windows.net/gatt-specification-supplement/GATT_Specification_Supplement.pdf
    let flags = dataView.getUint16(0, true);
    let index = 2;
    let result = {};
    if (flags & (1 << 0)) { // More Data; there is an additinal data record
        // not supported yet
    } else { // instead, instantaneous_speed present 
        result.instantaneous_speed = dataView.getUint16(index, true) * 0.01;  // Unit: km/h
    }
    index += 2;
    if (flags & (1 << 1)) {
        result.average_speed = dataView.getUint16(index, true) * 0.01;  // Unit: km/h
        index += 2;
    }
    if (flags & (1 << 2)) {
        result.instantaneous_cadence = dataView.getUint16(index, true) * 0.5;  // Unit: RPM
        index += 2;
    }
    if (flags & (1 << 3)) {
        result.average_cadence = dataView.getUint16(index, true) * 0.5;  // Unit: RPM
        index += 2;
    }
    if (flags & (1 << 4)) {
        result.total_distance = 
            dataView.getUint8(index) | 
            (dataView.getUint8(index + 1) << 8) | 
            (dataView.getUint8(index + 2) << 16);  // Unit: meter
        index += 3;
    }
    if (flags & (1 << 5)) {
        result.resistance_level = dataView.getUint8(index, true);
        index += 1;
    }
    if (flags & (1 << 6)) {
        result.instantaneous_power = dataView.getUint16(index, true);  // Unit: Watt
        index += 2;
    }
    if (flags & (1 << 7)) {
        result.average_power = dataView.getUint16(index, true);  // Unit: Watt
        index += 2;
    }
    if (flags & (1 << 8)) {
        result.total_energy = dataView.getUint16(index, true);  // Unit: kCal
        result.energy_per_hour = dataView.getUint16(index+2, true);  // Unit: kCal
        result.energy_per_minute = dataView.getUint8(index+4, true);  // Unit: kCal
        index += 5;
    }
    if (flags & (1 << 9)) {
        result.heart_rate = dataView.getUint8(index);  // Unit: BPM
        index += 1;
    }
    if (flags & (1 << 10)) {
        result.metabolic_equivalent = dataView.getUint8(index) * 0.1;  // Unit: METs
        index += 1;
    }
    if (flags & (1 << 11)) {
        result.elapsed_time = dataView.getUint16(index, true);  // Unit: sec
        index += 2;
    }
    if (flags & (1 << 12)) {
        result.remaining_time = dataView.getUint16(index, true);  // Unit: sec
        index += 2;
    }
    return result;
  }
}

// Simple UUID v4 generator for client identity
function uuidv4() {
  return (crypto?.randomUUID?.() || ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  ));
}

function getIdentity() {
  let userId = localStorage.getItem("userId");
  if (!userId) { userId = uuidv4(); localStorage.setItem("userId", userId); }
  let username = localStorage.getItem("username") || "Runner";
  localStorage.setItem("username", username);
  return { userId, username };
}

async function fetchStatus(userId) {
  try {
    const res = await fetch(`/api/status?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return data.status || null;
  } catch { return null; }
}

async function saveStatus(userId, location) {
  try {
    await fetch(`/api/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, location })
    });
  } catch {}
}

async function appendHistory(userId, point) {
  try {
    await fetch(`/api/history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, point })
    });
  } catch {}
}

function initMap(start) {
  if (!window.google || !google.maps) {
    console.warn("Google Maps API not available. Set GOOGLE_MAPS_API_KEY.");
    return null;
  }
  const el = qs("pano");
  const pos = (start?.lat && start?.lng) ? start : defaultLocation;
  const pano = new google.maps.StreetViewPanorama(el, {
    position: pos,
    pov: { heading: start?.heading ?? 165, pitch: 0 },
    zoom: 1,
    addressControl: true,
    motionTracking: true,
    fullscreenControl: false,
    linksControl: true,
    showRoadLabels: true,
  });
  const map = new google.maps.Map(qs('miniMap'), {
        center: pano.getPosition() || pos,
        zoom: 15,
        zoomControl: true,
        clickableIcons: false,
        mapId: "fcf78f824472c3b8"
  });
  map.setStreetView(pano);
  pano.addListener('position_changed', () => {
    const pos = pano.getPosition() || (pano.getLocation && pano.getLocation()?.latLng);
    if (pos) map.setCenter(pos);
  });
  //window.__pano = pano;
  return [map, pano];
}

function chooseForwardLink(pano) {
  const links = pano.getLinks() || [];
  const heading = pano.getPov().heading || 0;
  if (!links.length) return null;
  let best = links[0];
  let bestScore = 999;
  for (const l of links) {
    const diff = Math.abs(angleDelta(heading, l.heading || 0));
    const score = diff;
    if (score < bestScore) { bestScore = score; best = l; }
  }
  return best;
}

function angleDelta(a, b) {
  let d = ((b - a + 540) % 360) - 180; // in [-180, 180)
  return d;
}

window.addEventListener("DOMContentLoaded", async () => {
  const ident = getIdentity();
  const last = await fetchStatus(ident.userId);
  const defaultLocation = {lat:35.681296, lng:139.758922, heading: 190}; // Otemachi, Tokyo
  const [map, pano] = initMap(last || defaultLocation);
  if (!map) return;

  const glyphImg = document.createElement("img");
  glyphImg.src = "/circle_dot.png";

  const session = {
    dailyDistanceM: 0,
    distance_togo: 0,
    prevPosition: null,
    lastHistoryPoint: null,
    lastSaved: null,
    turnBlocked: false,
    // For header speed measurement
    prevTimeMs: Date.now(),
    distSincePrevTimeM: 0,
    dayStr: new Date().toISOString().slice(0,10),
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

  function setConnectedUI(isConnected) {
    ui.connectBtn.style.display = isConnected ? 'none' : '';
    if (ui.disconnectBtn) ui.disconnectBtn.style.display = isConnected ? '' : 'none';
  }

  const MAX_BACKLOG_M = 200; // cap backlog in meters to avoid runaway

  const walker = new BLEWalker();
  walker.onConnectionChange = (isConnected) => setConnectedUI(isConnected);
  walker.onData = () => {
    const total = walker.sensors.distanceM || 0;
    if (walker.sensors.prevDistance == null) {
      walker.sensors.prevDistance = total;
    }
    const delta = total - walker.sensors.prevDistance;
    walker.sensors.prevDistance = total;
    if (Number.isFinite(delta) && delta > 0) {
      onSensorDistanceDelta(delta * 0.9); // scale by 0.9 because sensor is too fast.
      renderMetrics(walker.sensors, walker);
    }
  };
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

  function advance() {
    //console.log("advancing...");
    const link = chooseForwardLink(pano);
    if (!link) return;
    const pov = pano.getPov();
    const turnAngle = Math.abs(angleDelta(pov.heading || 0, link.heading || 0));
    // If a large turn is needed, block advancement and alert the user
    if (turnAngle > 80) {
      console.log("turn blocked. angle: " + turnAngle);
      beep(180, 880);
      showTurnToast(true);
      session.turnBlocked = true;
      return;
    }
    // Clear any previous turn block UI
    if (session.turnBlocked) { showTurnToast(false); }
    session.turnBlocked = false;
    // Move forward, invoking link_changed event.
    pano.setPano(link.pano);
    // If the turn is significant, align the view to the link heading
    if (turnAngle > 45) {
      pano.setPov({heading: link.heading || pov.heading, pitch: 0 });
    }
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
    // Evaluate turn feasibility for the next step
    const link = chooseForwardLink(pano);
    const pov = pano.getPov();
    const turnAngle = link ? Math.abs(angleDelta(pov.heading || 0, link.heading || 0)) : 0;
    session.turnBlocked = link ? (turnAngle > 80) : false;
    // Show when blocked; hide when unblocked
    showTurnToast(session.turnBlocked);
    if (session.turnBlocked) { beep(180, 880); }
    if (rest_togo > 0 && !session.turnBlocked) {
      advance();
    }
  });

  // Called after links_changed event.
  pano.addListener("position_changed", () => {
    const loc = pano.getLocation();
    if (!loc || !loc.latLng) return;
    const currentPos = { lat: loc.latLng.lat(), lng: loc.latLng.lng() };
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
    if (moved > 20) { // reset when large changes caused by manual/pegman move on mini map.
      session.distance_togo = 0;
      session.prevPosition = currentPos;
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
    // Update header speed using distance/time window
    session.distSincePrevTimeM += moved;
    const now = Date.now();
    const diffSec = (now - (session.prevTimeMs || now)) / 1000;
    if (diffSec > 10) { // update every >10 sec
      const speedKmh = (session.distSincePrevTimeM / diffSec) * 3.6;
      ui.hdrSpeed.textContent = (Number.isFinite(speedKmh) ? speedKmh : 0).toFixed(1);
      session.prevTimeMs = now;
      session.distSincePrevTimeM = 0;
    }

    putMarker(session.prevPosition);
    session.prevPosition = currentPos;
    // Persist only after moving ≥10 m per spec (no time fallback)
    const changed = !session.lastSaved || distMeters(session.lastSaved, currentPos) >= 10;
    if (changed) { 
      session.lastSaved = { ...currentPos, t: performance.now() };
      const heading = pano.getPov()?.heading || 0;
      saveStatus(ident.userId, { ...currentPos, heading });
      appendHistory(ident.userId, { ...currentPos, heading, ts: Date.now() });
    }
  });

  // BLE controls
  const doConnect = async () => {
    try {
      deviceStatus.status.textContent = 'Connecting…';
      await walker.connect();
    } catch (e) {
      deviceStatus.status.textContent = String(e.message || e);
    }
  };
  if (ui.connectBtn) ui.connectBtn.addEventListener('click', doConnect);
  // No explicit disconnect button per spec; disconnect via OS/BLE UI

  // Daily distance persistence (localStorage)
  const dayString = () => new Date().toISOString().slice(0,10);
  const ddKey = (dStr) => `dailyDistance:${ident.userId}:${dStr}`;
  const loadDailyDistanceFor = (dStr) => {
    const v = parseFloat(localStorage.getItem(ddKey(dStr)) ?? '');
    return Number.isFinite(v) ? v : 0;
  };
  const saveDailyDistanceFor = (dStr, val) => {
    try { localStorage.setItem(ddKey(dStr), String(val)); } catch {}
  };
  // Initialize today's distance from localStorage
  session.dailyDistanceM = loadDailyDistanceFor(session.dayStr);
  ui.hdrDayKm.textContent = (session.dailyDistanceM/1000).toFixed(2);

  // Load today's history and draw markers on mini map (no distance calc)
  async function loadHistoryAndMarkers() {
    const todayStr = session.dayStr;
    try {
      const res = await fetch(`/api/history?userId=${encodeURIComponent(ident.userId)}&day=${todayStr}`);
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      // Draw markers only
      for (let i = 0; i < items.length; i++) {
        const p = items[i];
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
          putMarker({ lat: p.lat, lng: p.lng });
        }
      }
      // Set prev position to last point for subsequent movement tracking
      const last = items[items.length - 1];
      if (last && Number.isFinite(last.lat) && Number.isFinite(last.lng)) {
        session.prevPosition = { lat: last.lat, lng: last.lng };
      }
    } catch {}
  }
  await loadHistoryAndMarkers();
  // Side pane toggle: hidden by default; show with side-open on all screens
  ui.togglePane.addEventListener('click', () => {
    document.body.classList.toggle('side-open');
  });

  function putMarker(location) {
      try {
          if (google.maps.marker && google.maps.marker.AdvancedMarkerElement) {
            new google.maps.marker.AdvancedMarkerElement({
              position: location,
              map: map,
              content: glyphImg.cloneNode(true)
            });
          } else {
            new google.maps.Marker({ position: location, map });
          }
      }
      catch  (error) {
          console.error("Error in putting marker:", error);
          //throw error;
      }
  }
});

// Haversine distance
function distMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
