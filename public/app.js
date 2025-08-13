/* Street View Walkthrough + Web Bluetooth (RSC/CSC/FTMS) */

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
}

class BLEWalker {
  constructor(onUpdate) {
    this.device = null;
    this.server = null;
    this.onUpdate = onUpdate;
    this.metrics = new Metrics();
    this._lastCrank = null; // for CSC cadence
    this._activeService = null; // 'RSC' | 'CSC' | 'FTMS' | null
  }
  get activeService() { return this._activeService; }
  async connect() {
    const options = {
      acceptAllDevices: true,
      optionalServices: [0x1814, 0x1816, 0x1826, 0x180d], // RSC, CSC, FTMS, HR
    };
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    this.server = await this.device.gatt.connect();
    // Try services in preferred order
    if (await this._tryRSC()) return;
    if (await this._tryFTMS()) return;
    if (await this._tryCSC()) return;
    this._status('Connected (no supported service)');
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
  async _tryRSC() {
    try {
      const svc = await this.server.getPrimaryService(0x1814);
      const ch = await svc.getCharacteristic(0x2a53); // RSC Measurement
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => this._onRSC(e.target.value));
      this._activeService = 'RSC';
      this._status('Connected (RSC)');
      return true;
    } catch { return false; }
  }
  _onRSC(dv) {
    // Spec: Flags(8), Inst Speed(uint16, 1/256 m/s), Inst Cadence(uint8 spm), [Stride Len uint16 1/100 m], [Total Dist uint32 1/10 m]
    const flags = dv.getUint8(0);
    const speed = dv.getUint16(1, true) / 256;
    const cadence = dv.getUint8(3);
    this.metrics.speedMps = speed;
    this.metrics.cadenceSpm = cadence;
    this.metrics.integrate();
    this._emit();
  }
  async _tryFTMS() {
    try {
      const svc = await this.server.getPrimaryService(0x1826);
      const treadmillCharUUID = 0x2acd; // Treadmill Data
      const ch = await svc.getCharacteristic(treadmillCharUUID);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => this._onFTMS(e.target.value));
      this._activeService = 'FTMS';
      this._status('Connected (FTMS)');
      return true;
    } catch { return false; }
  }
  _onFTMS(dv) {
    // Flags(16), Instantaneous Speed (uint16, 1/100 m/s) present if bit0
    const flags = dv.getUint16(0, true);
    let off = 2;
    if (flags & 0x0001) {
      const speed = dv.getUint16(off, true) / 100; off += 2;
      this.metrics.speedMps = speed;
    }
    this.metrics.integrate();
    this._emit();
  }
  async _tryCSC() {
    try {
      const svc = await this.server.getPrimaryService(0x1816);
      const ch = await svc.getCharacteristic(0x2a5b); // CSC Measurement
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => this._onCSC(e.target.value));
      this._activeService = 'CSC';
      this._status('Connected (CSC)');
      return true;
    } catch { return false; }
  }
  _onCSC(dv) {
    // Flags(8), WheelRevs?, CrankRevs?
    const flags = dv.getUint8(0);
    let off = 1;
    if (flags & 0x01) { // wheel present
      off += 6; // Cumulative Wheel Rev (u32) + Last Wheel Event (u16)
    }
    if (flags & 0x02) { // crank present
      const crank = dv.getUint16(off, true); off += 2;
      const time = dv.getUint16(off, true); off += 2; // 1/1024s units
      if (this._lastCrank) {
        const dCount = (crank - this._lastCrank.crank) & 0xffff;
        let dTime = (time - this._lastCrank.time) & 0xffff; // wrap
        if (dTime > 0) {
          const secs = dTime / 1024;
          const cps = dCount / secs; // counts per second
          const spm = cps * 60; // steps per minute (approx from crank revs)
          this.metrics.cadenceSpm = Math.round(spm);
          // Approximate speed from cadence with stride estimate (1.0 m/step)
          this.metrics.speedMps = (this.metrics.cadenceSpm / 60) * 1.0;
        }
      }
      this._lastCrank = { crank, time };
    }
    this.metrics.integrate();
    this._emit();
  }
}

function initPano() {
  if (!window.google || !google.maps) {
    console.warn("Google Maps API not available. Set GOOGLE_MAPS_API_KEY.");
    return null;
  }
  const el = qs("pano");
  const pos = { lat: 37.769263, lng: -122.450727 }; // SF default
  const pano = new google.maps.StreetViewPanorama(el, {
    position: pos,
    pov: { heading: 165, pitch: 0 },
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

window.addEventListener("DOMContentLoaded", () => {
  const pano = initPano();
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

  let lastAdvanceCheck = performance.now();
  let advanceAccumulator = 0; // meters accumulated since last move

  function advance() {
    const link = chooseForwardLink(pano);
    if (!link) return;
    pano.setPano(link.pano);
    const pov = pano.getPov();
    pano.setPov({ ...pov, heading: link.heading || pov.heading });
  }

  function loop() {
    const metersPerMove = Math.max(1, Number(ui.metersPerMove.value) || 8);
    const mock = Number(ui.mockSpeed.value) || 0;
    walker.metrics.integrate(mock);

    // Auto-advance by distance buckets
    const now = performance.now();
    const dt = Math.max(0, (now - lastAdvanceCheck) / 1000);
    lastAdvanceCheck = now;
    advanceAccumulator += (walker.metrics.speedMps || mock) * dt;
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
});

