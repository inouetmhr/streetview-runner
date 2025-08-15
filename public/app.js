/* Street View Walkthrough + Web Bluetooth (FTMS only) */

function qs(id) { return document.getElementById(id); }

class Metrics {
  constructor() {
    this.speedKmh = 0; // km/h
    this.cadenceRpm = 0; // rpm
    this.distanceM = 0;
    this.lastUpdate = performance.now();
  }
  integrate(mockSpeedMps = 0) {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    // Fallback integrates mock speed only (ignore BLE instantaneous speed)
    const v = mockSpeedMps || 0;
    this.distanceM += v * dt;
  }
  addDistance(deltaM, speedHintMps = null) {
    if (deltaM > 0 && Number.isFinite(deltaM)) {
      this.distanceM += deltaM;
    }
    // speedHintMpsはm/sなので、km/hに変換して格納
    if (speedHintMps != null && Number.isFinite(speedHintMps)) {
      this.speedKmh = speedHintMps * 3.6;
    }
    this.lastUpdate = performance.now();
  }
}

class BLEWalker {
  constructor(onUpdate) {
    this.device = null;
    this.server = null;
    this.onUpdate = onUpdate;
    this.metrics = new Metrics();
    this._activeService = null; // 'FTMS' | null
    this.usesDistanceFromSensor = false;
    // no FTMS delta tracking needed; distance comes from total_distance
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
  }
  _status(s) {
    qs('status').textContent = s;
  }
  _emit() {
    this.onUpdate?.(this.metrics, this);
  }
  async _tryFTMS() {
    try {
      const svc = await this.server.getPrimaryService(0x1826);
      const indoorBikeDataUUID = 0x2ad2; // Indoor Bike Data
      const ch = await svc.getCharacteristic(indoorBikeDataUUID);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => this._onFTMS(e.target.value));
      this._activeService = 'FTMS';
      this._status('Connected (FTMS: Indoor Bike)');
      return true;
    } catch { return false; }
  }
  _onFTMS(dv) {
    const data = this._parseIndoorBikeData(dv);
    if (data.instantaneous_cadence) {
      this.metrics.cadenceRpm = Math.round(data.instantaneous_cadence);
    }
    if (data.instantaneous_speed) {
      this.metrics.speedKmh = data.instantaneous_speed
    }
    if (data.total_distance != null) {
      this.metrics.distanceM = data.total_distance;
      this.usesDistanceFromSensor = true;
    } else {
      this.usesDistanceFromSensor = false;
    }
    this._emit();
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

function initPano(start) {
  if (!window.google || !google.maps) {
    console.warn("Google Maps API not available. Set GOOGLE_MAPS_API_KEY.");
    return null;
  }
  const el = qs("pano");
  const pos = start?.lat && start?.lng ? { lat: start.lat, lng: start.lng } : { lat: 37.769263, lng: -122.450727 };
  const pano = new google.maps.StreetViewPanorama(el, {
    position: pos,
    pov: { heading: start?.heading ?? 165, pitch: 0 },
    zoom: 1,
    addressControl: true,
    motionTracking: false,
    fullscreenControl: false,
    linksControl: true,
    showRoadLabels: true,
  });
  window.__pano = pano;
  return pano;
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
  const pano = initPano(last);
  if (!pano) return;
  
  const ui = {
    deviceName: qs('deviceName'),
    serviceName: qs('serviceName'),
    status: qs('status'),
    speed: qs('speed'),
    cadence: qs('cadence'),
    distance: qs('distance'),
    metersPerMove: qs('metersPerMove'),
    autoAdvance: qs('autoAdvance'),
    mockSpeed: qs('mockSpeed'),
    lat: qs('lat'),
    lng: qs('lng'),
    goBtn: qs('goBtn'),
    connectBtn: qs('connectBtn'),
    disconnectBtn: qs('disconnectBtn'),
    advanceBtn: qs('advanceBtn'),
    turnLeftBtn: qs('turnLeftBtn'),
    turnRightBtn: qs('turnRightBtn'),
  };
  
  let turnAlertUntil = 0;
  function renderMetrics(metrics, ble) {
    const now = performance.now();
    if (now < turnAlertUntil) {
      ui.speed.textContent = 'Turn!';
    } else {
      ui.speed.textContent = metrics.speedKmh.toFixed(1);
    }
    ui.cadence.textContent = Math.round(metrics.cadenceRpm);
    ui.distance.textContent = metrics.distanceM.toFixed(0);
    if (ble) {
      ui.deviceName.textContent = ble.device?.name || 'Unknown';
      ui.serviceName.textContent = ble.activeService || '—';
    }
  }

  const uiHeader = {
    hdrSpeed: qs('hdrSpeed'),
    hdrDayKm: qs('hdrDayKm'),
    connectBtn: qs('connectBtn'),
    togglePane: qs('togglePane'),
  };

  function setConnectedUI(isConnected) {
    uiHeader.connectBtn.style.display = isConnected ? 'none' : '';
  }

  const walker = new BLEWalker((metrics, ble) => {
    renderMetrics(metrics, ble);
    // Update header speed (supports Turn! overlay via renderMetrics state)
    const now = performance.now();
    if (now < turnAlertUntil) {
      uiHeader.hdrSpeed.textContent = 'Turn!';
    } else {
      uiHeader.hdrSpeed.textContent = metrics.speedKmh.toFixed(1);
    }
    setConnectedUI(Boolean(ble && ble.activeService));
  });
  
  let advanceAccumulator = 0; // meters accumulated since last move
  let lastAccumDistance = 0;
  // Rate limiting to avoid resource exhaustion from rapid pano changes
  const ADVANCE_MIN_INTERVAL_MS = 500; // at most ~2 moves/sec
  const MAX_ACCUMULATED_MOVES = 10; // cap backlog to avoid runaway
  let lastAdvanceAt = 0;
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
  
  function advance() {
    const link = chooseForwardLink(pano);
    if (!link) return;
    const pov = pano.getPov();
    const turnAngle = Math.abs(angleDelta(pov.heading || 0, link.heading || 0));
    // If a large turn is needed, alert and skip advancing for now
    if (turnAngle > 80) {
      turnAlertUntil = performance.now() + 1000; // show for 1s
      renderMetrics(walker.metrics, walker);
      beep(180, 880);
      // Reflect alert in header too
      uiHeader.hdrSpeed.textContent = 'Turn!';
      return;
    }
    // Move forward
    pano.setPano(link.pano);
    // If the turn is significant, align the view to the link heading
    if (turnAngle > 45) {
      pano.setPov({ ...pov, heading: link.heading || pov.heading });
    }
  }
  
  function loop() {
    const metersPerMove = Math.max(1, Number(ui.metersPerMove.value) || 8);
    const mock = Number(ui.mockSpeed.value) || 0;
    // Only integrate when not using sensor-provided distance
    if (!walker.usesDistanceFromSensor) {
      walker.metrics.integrate(mock);
    }

    // Auto-advance by actual distance traveled (from metrics)
    const curr = walker.metrics.distanceM;
    const dM = Math.max(0, curr - lastAccumDistance);
    lastAccumDistance = curr;
    advanceAccumulator += dM;
    // Clamp backlog to avoid many immediate pano loads
    advanceAccumulator = Math.min(advanceAccumulator, metersPerMove * MAX_ACCUMULATED_MOVES);
    if (ui.autoAdvance.value === 'on') {
      const now = performance.now();
      if (advanceAccumulator >= metersPerMove && (now - lastAdvanceAt) >= ADVANCE_MIN_INTERVAL_MS) {
        advance();
        advanceAccumulator -= metersPerMove;
        lastAdvanceAt = now;
      }
    }

    // Update UI from latest metrics (already updated via BLE callbacks and integrate)
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  
  // BLE controls
  ui.connectBtn.addEventListener('click', async () => {
    try {
      ui.status.textContent = 'Connecting…';
      await walker.connect();
      setConnectedUI(Boolean(walker.activeService));
    } catch (e) {
      ui.status.textContent = String(e.message || e);
    }
  });
  // No explicit disconnect button; user can disconnect from OS/BLE UI
  
  // Navigation controls
  ui.advanceBtn.addEventListener('click', advance);
  ui.turnLeftBtn.addEventListener('click', () => rotate(-22.5));
  ui.turnRightBtn.addEventListener('click', () => rotate(22.5));
  
  function rotate(delta) {
    const pov = pano.getPov();
    pano.setPov({ ...pov, heading: (pov.heading + delta + 360) % 360 });
  }
  
  // Start location controls
  ui.goBtn.addEventListener('click', () => {
    const lat = parseFloat(ui.lat.value);
    const lng = parseFloat(ui.lng.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      pano.setPosition({ lat, lng });
    }
  });
  
  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); advance(); }
    if (e.key === 'ArrowLeft') rotate(-22.5);
    if (e.key === 'ArrowRight') rotate(22.5);
    if (e.key.toLowerCase() === 'a') {
      ui.autoAdvance.value = ui.autoAdvance.value === 'on' ? 'off' : 'on';
    }
  });
  
  // Persist position and simple history on movement
  let lastSaved = null;
  // Daily distance tracker (km shown in header)
  let dailyDistanceM = 0;
  let lastHistoryPoint = null;

  // Load today's history and compute initial daily distance
  const todayStr = new Date().toISOString().slice(0,10);
  try {
    const hist = await fetch(`/api/history?userId=${encodeURIComponent(ident.userId)}&day=${todayStr}`);
    if (hist.ok) {
      const data = await hist.json();
      const items = Array.isArray(data.items) ? data.items : [];
      for (let i = 1; i < items.length; i++) {
        dailyDistanceM += distMeters(items[i-1], items[i]);
      }
      lastHistoryPoint = items[items.length - 1] || null;
    }
  } catch {}
  uiHeader.hdrDayKm.textContent = (dailyDistanceM/1000).toFixed(1);
  pano.addListener("position_changed", () => {
    const loc = pano.getLocation();
    if (!loc || !loc.latLng) return;
    const lat = loc.latLng.lat();
    const lng = loc.latLng.lng();
    const heading = pano.getPov()?.heading || 0;
    ui.lat.value = String(lat.toFixed(6));
    ui.lng.value = String(lng.toFixed(6));
    const now = performance.now();
    const changed = !lastSaved || distMeters(lastSaved, { lat, lng }) > 5 || (now - lastSaved.t) > 5000;
    if (changed) {
      lastSaved = { lat, lng, t: now };
      saveStatus(ident.userId, { lat, lng, heading });
      appendHistory(ident.userId, { lat, lng, heading, ts: Date.now() });
      // Update daily distance incrementally
      if (lastHistoryPoint) {
        dailyDistanceM += distMeters(lastHistoryPoint, { lat, lng });
      }
      lastHistoryPoint = { lat, lng };
      uiHeader.hdrDayKm.textContent = (dailyDistanceM/1000).toFixed(1);
    }
  });

  // Side pane collapse toggle
  uiHeader.togglePane.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('side-collapsed');
  });

  // Mini map setup
  try {
    const miniEl = qs('miniMap');
    if (miniEl && window.google && google.maps) {
      const initialPos = pano.getPosition() || (pano.getLocation && pano.getLocation()?.latLng) || new google.maps.LatLng(37.769263, -122.450727);
      const m = new google.maps.Map(miniEl, {
        center: initialPos,
        zoom: 16,
        disableDefaultUI: true,
        clickableIcons: false,
        mapId: undefined,
      });
      let marker = null;
      if (google.maps.Marker) {
        marker = new google.maps.Marker({ map: m, position: initialPos });
      }
      pano.addListener('position_changed', () => {
        const pos = pano.getPosition() || (pano.getLocation && pano.getLocation()?.latLng);
        if (pos) {
          m.setCenter(pos);
          if (marker) marker.setPosition(pos);
        }
      });
    }
  } catch (e) {
    console.warn('Mini map init failed:', e);
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
