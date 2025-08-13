/* Street View Walkthrough + Web Bluetooth (FTMS only) */

function qs(id) { return document.getElementById(id); }

class Metrics {
  constructor() {
    this.speedMps = 0; // meters/second
    this.cadenceSpm = 0; // steps per minute
    this.distanceM = 0;
    this.lastUpdate = performance.now();
  }
  integrate(mockSpeedMps = 0) {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    const v = this.speedMps || mockSpeedMps || 0;
    this.distanceM += v * dt;
  }
  addDistance(deltaM, speedHintMps = null) {
    if (deltaM > 0 && Number.isFinite(deltaM)) {
      this.distanceM += deltaM;
    }
    if (speedHintMps != null && Number.isFinite(speedHintMps)) {
      this.speedMps = speedHintMps;
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
    this._ftmsBaseM = null;
    this._ftmsPrevM = null;
    this._ftmsPrevT = null;
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
    // Indoor Bike Data (0x2AD2)
    // Flags (uint16, little-endian) indicate presence of fields.
    // Common fields:
    //  bit0: Instantaneous Speed present (uint16, 1/100 km/h)
    //  bit2: Instantaneous Cadence present (uint16, 1/2 rpm)
    //  bit6: Instantaneous Power present (sint16, watts)
    const flags = dv.getUint16(0, true);
    let off = 2;
    let speedMpsFromKmh = null;
    if (flags & 0x0001) {
      const speedKmh = dv.getUint16(off, true) / 100; off += 2;
      speedMpsFromKmh = speedKmh / 3.6;
    }
    if (flags & 0x0004) {
      const cadenceRpm = dv.getUint16(off, true) / 2; off += 2;
      this.metrics.cadenceSpm = Math.round(cadenceRpm); // display as cadence (rpm)
    }
    // Total Distance (meters) — typically 24-bit unsigned when present
    let totalM = null;
    if (flags & 0x0010) {
      const b0 = dv.getUint8(off);
      const b1 = dv.getUint8(off + 1);
      const b2 = dv.getUint8(off + 2);
      off += 3;
      totalM = (b0 | (b1 << 8) | (b2 << 16));
    }
    if (totalM != null) {
      // Prefer distance delta from sensor over integrating speed
      this.usesDistanceFromSensor = true;
      const tNow = performance.now();
      if (this._ftmsBaseM == null) this._ftmsBaseM = totalM;
      if (this._ftmsPrevM == null) this._ftmsPrevM = totalM;
      if (this._ftmsPrevT == null) this._ftmsPrevT = tNow;
      let dM = totalM - this._ftmsPrevM;
      if (dM < 0) {
        // Handle counter reset/wrap — reset baseline
        this._ftmsBaseM = totalM;
        dM = 0;
      }
      const dt = Math.max(0.001, (tNow - this._ftmsPrevT) / 1000);
      const mps = dM / dt;
      this.metrics.addDistance(dM, mps);
      this._ftmsPrevM = totalM;
      this._ftmsPrevT = tNow;
    } else {
      // Fall back to speed-based integration if no total distance provided
      this.usesDistanceFromSensor = false;
      if (speedMpsFromKmh != null) this.metrics.speedMps = speedMpsFromKmh;
      this.metrics.integrate();
    }
    this._emit();
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
    addressControl: false,
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

  const walker = new BLEWalker((metrics, ble) => {
    ui.speed.textContent = metrics.speedMps.toFixed(2);
    ui.cadence.textContent = Math.round(metrics.cadenceSpm);
    ui.distance.textContent = metrics.distanceM.toFixed(1);
    ui.deviceName.textContent = ble.device?.name || 'Unknown';
    ui.serviceName.textContent = ble.activeService || '—';
  });

  let advanceAccumulator = 0; // meters accumulated since last move
  let lastAccumDistance = 0;
  // Simple beep using Web Audio for turn alerts
  function beep(durationMs = 200, freq = 880) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
      o.start();
      o.stop(ctx.currentTime + durationMs / 1000 + 0.02);
    } catch {}
  }

  function advance() {
    const link = chooseForwardLink(pano);
    if (!link) return;
    const pov = pano.getPov();
    const turnAngle = Math.abs(angleDelta(pov.heading || 0, link.heading || 0));
    // If a large turn is needed, alert and skip advancing for now
    if (turnAngle > 80) {
      ui.status.textContent = 'Turn!';
      beep(180, 880);
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
    if (ui.autoAdvance.value === 'on') {
      while (advanceAccumulator >= metersPerMove) {
        advance();
        advanceAccumulator -= metersPerMove;
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
    } catch (e) {
      ui.status.textContent = String(e.message || e);
    }
  });
  ui.disconnectBtn.addEventListener('click', async () => {
    await walker.disconnect();
  });

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
    }
  });
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
