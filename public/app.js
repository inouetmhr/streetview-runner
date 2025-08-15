/* Street View Walkthrough + Web Bluetooth (FTMS only) */

function qs(id) { return document.getElementById(id); }

class Metrics {
  constructor() {
    this.speedKmh = 0; // km/h
    this.cadenceRpm = 0; // rpm
    this.distanceM = 0;
    this.lastUpdate = performance.now();
  }
}

class BLEWalker {
  constructor() {
    this.device = null;
    this.server = null;
    this.onBikeData = null; // () => void; consumer reads this.metrics/this
    this.metrics = new Metrics();
    this._activeService = null; // 'FTMS' | null
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
  async _tryFTMS() {
    try {
      const svc = await this.server.getPrimaryService(0x1826);
      const indoorBikeDataUUID = 0x2ad2; // Indoor Bike Data
      const ch = await svc.getCharacteristic(indoorBikeDataUUID);
      ch.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        this._onFTMS(dv);
        try { this.onBikeData?.(); } catch {}
      });
      await ch.startNotifications();
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
    motionTracking: true,
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
    connectBtn: qs('connectBtn'),          // header connect
  };
  
  // Turn alert state: show toast + 'Turn!' while blocked
  let turnBlocked = false;
  let prevTurnBlocked = false;
  function renderMetrics(metrics, ble) {
    if (turnBlocked) {
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
    if (ui.disconnectBtn) ui.disconnectBtn.style.display = isConnected ? '' : 'none';
  }

  // Bring back backlog and chaining (fixed meters per move)
  const MAX_BACKLOG_M = 200; // cap backlog in meters to avoid runaway
  let prevSensorDistance = null;
  const session = { distance_togo: 0 };

  const walker = new BLEWalker();
  walker.onBikeData = () => {
    const metrics = walker.metrics;
    const ble = walker;
    const total = metrics.distanceM || 0;
    if (prevSensorDistance == null) {
      prevSensorDistance = total;
    }
    const delta = total - prevSensorDistance;
    if (delta > 0) {
      let dM = total - prevSensorDistance;
      if (!Number.isFinite(dM) || dM < 0) dM = 0;
      bikeMoved(dM);
      renderMetrics(metrics, ble);
    }
    setConnectedUI(Boolean(ble && ble.activeService));
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
  
  const turnToast = document.getElementById('turnToast');
  function showTurnToast(show) {
    if (!turnToast) return;
    turnToast.style.display = show ? '' : 'none';
  }

  function advance() {
    const link = chooseForwardLink(pano);
    if (!link) return;
    const pov = pano.getPov();
    const turnAngle = Math.abs(angleDelta(pov.heading || 0, link.heading || 0));

    // If a large turn is needed, block advancement and alert the user
    if (turnAngle > 80) {
      if (!turnBlocked) { beep(180, 880); showTurnToast(true); }
      turnBlocked = true;
      return;
    }

    // Clear any previous turn block UI
    if (turnBlocked) { showTurnToast(false); }
    turnBlocked = false;

    // Move forward
    pano.setPano(link.pano);
    // If the turn is significant, align the view to the link heading
    if (turnAngle > 45) {
      pano.setPov({ ...pov, heading: link.heading || pov.heading });
    }
  }

  // Alias to match requested feature naming
  function moveForward() { advance(); }

  /* dbChanged を簡易化したBLE版。diff [meter] の分、前進する。
     実際の前進は moveForward で、これがどれくらい進むかは Maps 次第なので結果的にしか分からない。
     このため移動すべき残りの距離の分 moveFoward を繰り返してる。*/
  function bikeMoved(diff){
    console.log("bikeMoved: ", diff);
    if (isNaN(diff) || diff <= 0.0)  return; // not supposed
    session.distance_togo = Math.min((session.distance_togo || 0) + diff, MAX_BACKLOG_M);
    if (session.distance_togo > 0) {
        moveForward();
    } else {
        console.log("move skipped.");
    }
  }
  
  // Chaining: drain backlog when new links are available
  pano.addListener("links_changed", () => {
    const rest = session.distance_togo;
    console.log(`links_changed. rest to go: ${rest.toFixed(1)}`);
    // Evaluate turn feasibility for the next step
    const link = chooseForwardLink(pano);
    const pov = pano.getPov();
    const turnAngle = link ? Math.abs(angleDelta(pov.heading || 0, link.heading || 0)) : 0;
    turnBlocked = link ? (turnAngle > 80) : false;
    if (turnBlocked && !prevTurnBlocked) { beep(180, 880); showTurnToast(true); }
    if (!turnBlocked && prevTurnBlocked) { showTurnToast(false); }
    prevTurnBlocked = turnBlocked;
    if (rest > 0 && !turnBlocked) {
      moveForward();
    }
  });
  
  // BLE controls
  const doConnect = async () => {
    try {
      ui.status.textContent = 'Connecting…';
      await walker.connect();
      setConnectedUI(Boolean(walker.activeService));
    } catch (e) {
      ui.status.textContent = String(e.message || e);
    }
  };
  if (ui.connectBtn) ui.connectBtn.addEventListener('click', doConnect);
  // No explicit disconnect button per spec; disconnect via OS/BLE UI
  
  // Navigation UI removed (no buttons/controls per spec)
  
  // No explicit start location inputs per spec
  
  // Keyboard shortcuts removed (no keyboard control per spec)
  
  // Persist position and simple history on movement
  let lastSaved = null;
  // Daily distance tracker (km shown in header)
  let dailyDistanceM = 0;
  let lastHistoryPoint = null;
  // Track last pano position for backlog subtraction
  let lastPanoPosForBacklog = null;

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
    // Subtract actual moved distance from backlog
    if (lastPanoPosForBacklog) {
      const moved = distMeters(lastPanoPosForBacklog, { lat, lng });
      if (Number.isFinite(moved) && moved > 0) {
        session.distance_togo = Math.max(0, session.distance_togo - moved);
      }
    }
    lastPanoPosForBacklog = { lat, lng };
    const heading = pano.getPov()?.heading || 0;
    // Persist only after moving ≥10 m per spec (no time fallback)
    const changed = !lastSaved || distMeters(lastSaved, { lat, lng }) >= 10;
    if (changed) {
      lastSaved = { lat, lng, t: performance.now() };
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
