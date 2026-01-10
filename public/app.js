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

// Auth + API helpers
async function fetchStatus() {
  try {
    console.log("api/status: fetch");
    const res = await fetch(`/api/status`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    console.log("api/status: response", data);
    return data.ok ? {
      status: data.status || null,
      dailyDistanceMeters: Number.isFinite(data.dailyDistanceMeters) ? data.dailyDistanceMeters : null,
      day: data.day || null,
    } : null;
  } catch { return null; }
}

async function saveStatus(location) {
  try {
    await fetch(`/api/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location })
    });
  } catch {}
}

async function appendHistory(point) {
  try {
    await fetch(`/api/history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ point })
    });
  } catch {}
}

async function fetchHistoryRange(from, to) {
  try {
    const params = new URLSearchParams({ from, to });
    const res = await fetch(`/api/history?${params.toString()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function getSession() {
  try {
    const res = await fetch('/api/auth/session');
    if (!res.ok) return null;
    const j = await res.json();
    return j?.user || null;
  } catch { return null; }
}

async function registerWithPasskey(username) {
  try {
    const res1 = await fetch('/api/auth/register/options', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username })
    });
    if (!res1.ok) throw new Error('reg options failed');
    const { options, flowId } = await res1.json();
    const { startRegistration } = await import('https://esm.sh/@simplewebauthn/browser@13');
    const attResp = await startRegistration(options);
    const passkeyLabel = suggestPasskeyLabel();
    const res2 = await fetch('/api/auth/register/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId, response: attResp, passkeyLabel })
    });
    if (!res2.ok) throw new Error('reg verify failed');
    return (await res2.json())?.user || null;
  } catch (e) {
    console.warn('register error', e);
    return null;
  }
}

async function addPasskey() {
  try {
    const res1 = await fetch('/api/auth/passkeys/options', { method: 'POST' });
    if (!res1.ok) throw new Error('passkey options failed');
    const { options, flowId } = await res1.json();
    const { startRegistration } = await import('https://esm.sh/@simplewebauthn/browser@13');
    const attResp = await startRegistration(options);
    const suggested = suggestPasskeyLabel();
    const input = prompt('Label this passkey:', suggested);
    if (input === null) return null;
    const passkeyLabel = (input || '').trim() || suggested;
    const res2 = await fetch('/api/auth/passkeys/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId, response: attResp, passkeyLabel })
    });
    if (!res2.ok) throw new Error('passkey verify failed');
    return (await res2.json())?.user || null;
  } catch (e) {
    console.warn('add passkey error', e);
    return null;
  }
}

async function loginWithPasskey() {
  try {
    const res1 = await fetch('/api/auth/login/options', { method: 'POST' });
    if (!res1.ok) throw new Error('auth options failed');
    const { options, flowId } = await res1.json();
    const { startAuthentication } = await import('https://esm.sh/@simplewebauthn/browser@13');
    const asn = await startAuthentication(options);
    const res2 = await fetch('/api/auth/login/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId, response: asn })
    });
    if (!res2.ok) throw new Error('auth verify failed');
    return (await res2.json())?.user || null;
  } catch (e) {
    console.warn('login error', e);
    return null;
  }
}

async function logoutSession() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
}

async function updateUsername(username) {
  try {
    const res = await fetch('/api/auth/username', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username })
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.user || null;
  } catch { return null; }
}

async function fetchPasskeys() {
  try {
    const res = await fetch('/api/auth/passkeys');
    if (!res.ok) return { items: [], currentCredentialId: null };
    const j = await res.json();
    return {
      items: Array.isArray(j.items) ? j.items : [],
      currentCredentialId: j.currentCredentialId || null,
    };
  } catch { return { items: [], currentCredentialId: null }; }
}

async function deletePasskey(credentialId) {
  try {
    const res = await fetch('/api/auth/passkeys/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId })
    });
    if (!res.ok) return { ok: false, error: await res.json().catch(() => null) };
    const j = await res.json();
    return { ok: true, items: j.items || [], currentCredentialId: j.currentCredentialId || null };
  } catch {
    return { ok: false, error: null };
  }
}

async function renamePasskey(credentialId, label) {
  try {
    const res = await fetch('/api/auth/passkeys/label', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId, label })
    });
    if (!res.ok) return { ok: false, error: await res.json().catch(() => null) };
    const j = await res.json();
    return { ok: true, items: j.items || [], currentCredentialId: j.currentCredentialId || null };
  } catch {
    return { ok: false, error: null };
  }
}

function suggestPasskeyLabel() {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isIpad = /iPad/i.test(ua);
  const isIphone = /iPhone/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isWindows = /Win/i.test(platform);
  const isMac = /Mac/i.test(platform) && !isIOS;
  const isChromeOS = /CrOS/i.test(ua);
  let device = 'Device';
  if (isIphone) device = 'iPhone';
  else if (isIpad) device = 'iPad';
  else if (isIOS) device = 'iOS device';
  else if (isAndroid) device = /Mobile/i.test(ua) ? 'Android phone' : 'Android device';
  else if (isMac) device = 'Mac';
  else if (isWindows) device = 'Windows PC';
  else if (isChromeOS) device = 'Chromebook';
  const day = new Date().toISOString().slice(0, 10);
  return `${device} (${day})`;
}

// Generate friendly display names like "Blue Dragon"
function generateFriendlyName() {
  const left = [
    'Blue','Crimson','Golden','Silver','Emerald','Sapphire','Ruby','Azure','Scarlet','Ivory','Onyx','Amber','Cobalt','Violet','Indigo','Coral','Teal','Misty','Sunny','Silent','Brave','Swift','Lunar','Solar','Neon','Frosty','Wild'
  ];
  const right = [
    'Dragon','Tiger','Falcon','Wolf','Eagle','Lion','Leopard','Shark','Panther','Phoenix','Bear','Dolphin','Fox','Hawk','Otter','Orca','Raven','Puma','Cobra','Lynx','Viper','Kite','Stallion','Mustang'
  ];
  const a = left[Math.floor(Math.random()*left.length)];
  const b = right[Math.floor(Math.random()*right.length)];
  return `${a} ${b}`;
}

function toDateStringUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDateStringUTC(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function getLocaleFirstDayIndex() {
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = locale.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch {}
  return 1; // Monday
}

function getWeekRangeUTC(dayStr, firstDayIndex) {
  const base = parseDateStringUTC(dayStr) || new Date();
  const dayIndex = base.getUTCDay();
  const diff = (dayIndex - firstDayIndex + 7) % 7;
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - diff);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { from: toDateStringUTC(start), to: toDateStringUTC(end) };
}

function getMonthRangeUTC(monthStr) {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) {
    const now = new Date();
    monthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const [y, m] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { from: toDateStringUTC(start), to: toDateStringUTC(end) };
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
    addressControlOptions: { position: google.maps.ControlPosition.LEFT_BOTTOM },
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
  // Session/auth state and UI
  const uiUser = { name: qs('userName'), btnEdit: qs('btnEditName'), btnReg: qs('btnRegister'), btnLogin: qs('btnLogin'), btnAddPasskey: qs('btnAddPasskey'), btnLogout: qs('btnLogout'), hint: qs('authHint'), passkeyList: qs('passkeyList') };
  const authToast = { el: qs('authToast'), btnLogin: qs('toastLogin'), btnRegister: qs('toastRegister'), btnClose: qs('toastClose') };
  let sessionUser = await getSession();
  let isHistoryOpen = false;
  const dayString = () => new Date().toISOString().slice(0,10);
  let passkeyItems = [];
  let passkeyCurrentId = null;
  const renderPasskeys = () => {
    if (!uiUser.passkeyList) return;
    if (!sessionUser) {
      uiUser.passkeyList.textContent = '—';
      return;
    }
    if (!passkeyItems.length) {
      uiUser.passkeyList.textContent = 'none';
      return;
    }
    uiUser.passkeyList.innerHTML = '';
    passkeyItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.gap = '.5rem';
      row.style.margin = '.2rem 0';
      const currentLabel = item.label ? item.label : `Passkey ${index + 1}`;
      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = '.35rem';
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '.35rem';
      const btnRename = document.createElement('button');
      btnRename.className = 'ghost small btn-edit';
      btnRename.textContent = 'Edit';
      btnRename.title = 'Edit passkey label';
      btnRename.setAttribute('aria-label', 'Rename passkey');
      btnRename.addEventListener('click', async () => {
        const next = prompt('Rename passkey:', currentLabel);
        if (next === null) return;
        const trimmed = (next || '').trim();
        if (!trimmed) return;
        const res = await renamePasskey(item.id, trimmed);
        if (!res.ok) {
          alert(res.error?.error || 'Failed to rename passkey.');
          return;
        }
        passkeyItems = res.items || [];
        passkeyCurrentId = res.currentCredentialId || null;
        renderPasskeys();
      });
      const label = document.createElement('span');
      label.textContent = currentLabel;
      const btnRemove = document.createElement('button');
      btnRemove.className = 'ghost small icon';
      btnRemove.textContent = '🗑';
      btnRemove.title = 'Remove passkey';
      btnRemove.setAttribute('aria-label', 'Remove passkey');
      btnRemove.addEventListener('click', async () => {
        const isCurrent = item.id && passkeyCurrentId && item.id === passkeyCurrentId;
        const message = isCurrent
          ? 'WARN: This is the passkey CURRENTLY USED. Remove anyway?'
          : 'Remove this passkey?';
        if (!confirm(message)) return;
        const res = await deletePasskey(item.id);
        if (!res.ok) {
          alert(res.error?.error || 'Failed to remove passkey.');
          return;
        }
        passkeyItems = res.items || [];
        passkeyCurrentId = res.currentCredentialId || null;
        renderPasskeys();
      });
      left.appendChild(label);
      left.appendChild(btnRename);
      actions.appendChild(btnRemove);
      row.appendChild(left);
      row.appendChild(actions);
      uiUser.passkeyList.appendChild(row);
    });
  };
  const refreshPasskeys = async () => {
    if (!sessionUser) {
      passkeyItems = [];
      passkeyCurrentId = null;
      renderPasskeys();
      return;
    }
    const res = await fetchPasskeys();
    passkeyItems = res.items || [];
    passkeyCurrentId = res.currentCredentialId || null;
    renderPasskeys();
  };
  const updateUserUI = () => {
    if (sessionUser) {
      uiUser.name.textContent = sessionUser.username || 'Runner';
      uiUser.btnReg.style.display = 'none';
      if (uiUser.btnEdit) uiUser.btnEdit.style.display = '';
      uiUser.btnLogin.style.display = 'none';
      if (uiUser.btnAddPasskey) uiUser.btnAddPasskey.style.display = '';
      uiUser.btnLogout.style.display = '';
      uiUser.hint.style.display = 'none';
      setAuthToastVisible(false);
    } else {
      uiUser.name.textContent = '—';
      uiUser.btnReg.style.display = '';
      if (uiUser.btnEdit) uiUser.btnEdit.style.display = 'none';
      uiUser.btnLogin.style.display = '';
      if (uiUser.btnAddPasskey) uiUser.btnAddPasskey.style.display = 'none';
      uiUser.btnLogout.style.display = 'none';
      uiUser.hint.style.display = '';
      setAuthToastVisible(true);
    }
    renderPasskeys();
  };
  updateUserUI();

  // Last known position persistence (localStorage), scoped per user
  const lpKey = (userId) => `lastPosition:${userId || 'anon'}`;
  const loadLastPositionFor = (userId) => {
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
  };
  const saveLastPositionFor = (userId, pos) => {
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
    const next = {
      lat: pos.lat,
      lng: pos.lng,
      heading: Number.isFinite(pos.heading) ? pos.heading : 0,
      ts: Number.isFinite(pos.ts) ? pos.ts : Date.now(),
    };
    try { localStorage.setItem(lpKey(userId), JSON.stringify(next)); } catch {}
  };

  let map = null;
  let pano = null;
  let historyMap = null;
  let historyPolyline = null;

  const historyUI = {
    section: qs('historySection'),
    toggle: qs('historyToggle'),
    body: qs('historyBody'),
    modeDay: qs('historyModeDay'),
    modeWeek: qs('historyModeWeek'),
    modeMonth: qs('historyModeMonth'),
    prevBtn: qs('historyPrev'),
    nextBtn: qs('historyNext'),
    inputDay: qs('historyDay'),
    inputWeek: qs('historyWeek'),
    inputMonth: qs('historyMonth'),
    range: qs('historyRange'),
    distance: qs('historyDistance'),
    status: qs('historyStatus'),
  };
  const historyFirstDayIndex = getLocaleFirstDayIndex();
  let historyMode = "day";

  const captureCurrentPosition = () => {
    const pos = pano?.getPosition?.() || map?.getCenter?.();
    if (!pos) return null;
    const lat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
    const lng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const heading = pano?.getPov?.()?.heading;
    return { lat, lng, heading: Number.isFinite(heading) ? heading : 0 };
  };

  const doRegister = async () => {
    const wasAnonymous = !sessionUser;
    const suggested = generateFriendlyName();
    let input = prompt('Choose your display name:', suggested);
    if (input === null) return; // user canceled
    const username = (input || '').trim() || suggested;
    const user = await registerWithPasskey(username);
    if (user) {
      if (wasAnonymous) {
        const inherited = captureCurrentPosition() || loadLastPositionFor(null);
        if (inherited) saveLastPositionFor(user.userId, inherited);
      }
      sessionUser = user;
      updateUserUI();
      session.ignoreNextHistorySave = true;
      await afterLogin();
      await refreshHistoryView();
      await refreshPasskeys();
    }
  };
  const doLogin = async () => {
    const user = await loginWithPasskey();
    if (user) {
      sessionUser = user;
      updateUserUI();
      session.ignoreNextHistorySave = true;
      await afterLogin();
      await refreshHistoryView();
      await refreshPasskeys();
    }
  };
  const doAddPasskey = async () => {
    if (!sessionUser) return;
    const user = await addPasskey();
    if (user) {
      sessionUser = user;
      updateUserUI();
      await refreshPasskeys();
      alert('Passkey added to your account.');
    }
  };
  const doLogout = async () => {
    const pos = captureCurrentPosition();
    if (pos) saveLastPositionFor(null, pos);
    await logoutSession();
    try { document.body.classList.remove('side-open'); } catch {}
    // Reload to reset app state and enforce unauthenticated flows
    location.reload();
  };
  uiUser.btnReg?.addEventListener('click', doRegister);
  uiUser.btnLogin?.addEventListener('click', doLogin);
  uiUser.btnAddPasskey?.addEventListener('click', doAddPasskey);
  uiUser.btnLogout?.addEventListener('click', doLogout);
  uiUser.btnEdit?.addEventListener('click', async () => {
    if (!sessionUser) return;
    const suggested = sessionUser.username || generateFriendlyName();
    const next = prompt('Edit display name:', suggested);
    if (next === null) return;
    const name = (next || '').trim();
    if (!name) return;
    const updated = await updateUsername(name);
    if (updated) { sessionUser = updated; updateUserUI(); }
  });
  // Toast actions mirror side-pane buttons
  authToast.btnRegister?.addEventListener('click', doRegister);
  authToast.btnLogin?.addEventListener('click', doLogin);
  authToast.btnClose?.addEventListener('click', () => { setAuthToastVisible(false); });

  const resolveLatestPosition = (localPos, serverPos) => {
    if (!localPos) return { pos: serverPos || null, preferLocal: false };
    if (!serverPos) return { pos: localPos, preferLocal: true };
    const localTs = Number.isFinite(localPos.ts) ? localPos.ts : 0;
    const serverTs = Number.isFinite(serverPos.ts) ? serverPos.ts : 0;
    const preferLocal = localTs > serverTs;
    return { pos: preferLocal ? localPos : serverPos, preferLocal };
  };
  const getStartState = async (userId) => {
    const local = loadLastPositionFor(userId);
    const statusResp = userId ? await fetchStatus() : null;
    const server = statusResp?.status || null;
    return { local, statusResp, resolved: resolveLatestPosition(local, server) };
  };

  // Map init: prefer server if newer; otherwise keep newer local position
  const initialStart = await getStartState(sessionUser?.userId);
  const VISIBILITY_SYNC_MS = 60 * 1000;
  let lastVisibilitySyncAt = Date.now();
  const last = initialStart.resolved.pos;
  const defaultLocation = {lat:35.681296, lng:139.758922, heading: 190}; // Otemachi, Tokyo
  [map, pano] = initMap(last || defaultLocation) || [];
  if (!map || !pano) return;

  const glyphImg = document.createElement("img");
  glyphImg.src = "/circle_dot.png";

  const session = {
    dailyDistanceM: 0,
    distance_togo: 0,
    prevPosition: null,
    lastHistoryPoint: null,
    lastStatusSaved: null,
    lastHistorySaved: null,
    turnBlocked: false,
    ignoreNextHistorySave: false,
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

  const applyServerDailyDistance = (statusResp, preferLocal) => {
    const serverDay = statusResp?.day || session.dayStr;
    const serverDistanceM = statusResp?.dailyDistanceMeters;
    if (Number.isFinite(serverDistanceM) && serverDay === session.dayStr && !preferLocal) {
      session.dailyDistanceM = serverDistanceM;
      saveDailyDistanceFor(session.dayStr, session.dailyDistanceM);
      ui.hdrDayKm.textContent = (session.dailyDistanceM / 1000).toFixed(2);
    }
  };

  // After login tasks: refresh status and load today's history markers
  async function afterLogin() {
    try {
      const nextStart = await getStartState(sessionUser?.userId);
      const next = nextStart.resolved.pos;
      if (next && Number.isFinite(next.lat) && Number.isFinite(next.lng)) {
        try {
          pano.setPosition({ lat: next.lat, lng: next.lng });
          if (Number.isFinite(next.heading)) {
            const pov = pano.getPov() || {}; pov.heading = next.heading; pov.pitch = 0; pano.setPov(pov);
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
    if (!sessionUser) return;
    await afterLogin();
    if (historyUI.body?.classList.contains("open")) {
      await refreshHistoryView();
    }
  });

  function ensureHistoryMap() {
    if (historyMap || !window.google || !google.maps) return;
    historyMap = new google.maps.Map(qs('historyMap'), {
      center: { lat: defaultLocation.lat, lng: defaultLocation.lng },
      zoom: 14,
      clickableIcons: false,
      mapId: "fcf78f824472c3b8",
      fullscreenControl: false,
      streetViewControl: false,
      mapTypeControl: false,
    });
  }

  function clearHistoryPolyline() {
    if (historyPolyline) {
      historyPolyline.setMap(null);
      historyPolyline = null;
    }
  }

  function drawHistoryPolyline(items) {
    if (!historyMap) return;
    clearHistoryPolyline();
    const path = items
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!path.length) return;
    historyPolyline = new google.maps.Polyline({
      path,
      strokeColor: "#2563eb",
      strokeOpacity: 0.9,
      strokeWeight: 4,
      map: historyMap,
    });
    if (path.length === 1) {
      historyMap.setCenter(path[0]);
      historyMap.setZoom(16);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    historyMap.fitBounds(bounds, 240);
  }

  function updateHistoryModeButtons() {
    const modes = [
      { mode: "day", btn: historyUI.modeDay },
      { mode: "week", btn: historyUI.modeWeek },
      { mode: "month", btn: historyUI.modeMonth },
    ];
    modes.forEach(({ mode, btn }) => {
      if (!btn) return;
      btn.classList.toggle("active", historyMode === mode);
    });
    if (historyUI.inputDay) historyUI.inputDay.style.display = historyMode === "day" ? "" : "none";
    if (historyUI.inputWeek) historyUI.inputWeek.style.display = historyMode === "week" ? "" : "none";
    if (historyUI.inputMonth) historyUI.inputMonth.style.display = historyMode === "month" ? "" : "none";
  }

  function getHistoryRangeFromInputs() {
    if (historyMode === "day") {
      const day = historyUI.inputDay?.value || dayString();
      return { from: day, to: day };
    }
    if (historyMode === "week") {
      const day = historyUI.inputWeek?.value || dayString();
      return getWeekRangeUTC(day, historyFirstDayIndex);
    }
    const month = historyUI.inputMonth?.value || dayString().slice(0, 7);
    return getMonthRangeUTC(month);
  }

  function shiftHistoryPeriod(direction) {
    if (historyMode === "day") {
      const base = parseDateStringUTC(historyUI.inputDay?.value || dayString()) || new Date();
      base.setUTCDate(base.getUTCDate() + direction);
      if (historyUI.inputDay) historyUI.inputDay.value = toDateStringUTC(base);
      return;
    }
    if (historyMode === "week") {
      const base = parseDateStringUTC(historyUI.inputWeek?.value || dayString()) || new Date();
      base.setUTCDate(base.getUTCDate() + (direction * 7));
      if (historyUI.inputWeek) historyUI.inputWeek.value = toDateStringUTC(base);
      return;
    }
    const monthStr = historyUI.inputMonth?.value || dayString().slice(0, 7);
    const [y, m] = monthStr.split("-").map(Number);
    const next = new Date(Date.UTC(y, (m - 1) + direction, 1));
    const nextStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    if (historyUI.inputMonth) historyUI.inputMonth.value = nextStr;
  }

  async function refreshHistoryView() {
    if (!historyUI.body || !historyUI.body.classList.contains("open")) return;
    if (!historyUI.status || !historyUI.range || !historyUI.distance) return;
    if (!sessionUser) {
      historyUI.status.textContent = "Sign in to view history.";
      historyUI.range.textContent = "—";
      historyUI.distance.textContent = "—";
      clearHistoryPolyline();
      return;
    }
    const range = getHistoryRangeFromInputs();
    if (!range?.from || !range?.to) {
      historyUI.status.textContent = "Invalid date.";
      historyUI.range.textContent = "—";
      historyUI.distance.textContent = "—";
      clearHistoryPolyline();
      return;
    }
    historyUI.range.textContent = `${range.from} to ${range.to}`;
    historyUI.status.textContent = "Loading...";
    ensureHistoryMap();
    if (!historyMap) {
      historyUI.status.textContent = "Maps API not available.";
      return;
    }
    const data = await fetchHistoryRange(range.from, range.to);
    if (!data?.ok) {
      historyUI.status.textContent = "Failed to load history.";
      clearHistoryPolyline();
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const distanceMeters = data.summary?.distanceMeters;
    if (Number.isFinite(distanceMeters)) {
      historyUI.distance.textContent = `${(distanceMeters / 1000).toFixed(2)} km`;
    } else {
      historyUI.distance.textContent = "—";
    }
    if (!items.length) {
      historyUI.status.textContent = "No history in this range.";
      clearHistoryPolyline();
      return;
    }
    historyUI.status.textContent = "";
    drawHistoryPolyline(items);
  }

  function setHistoryOpen(open) {
    if (!historyUI.body || !historyUI.toggle) return;
    isHistoryOpen = open;
    historyUI.body.classList.toggle("open", open);
    historyUI.toggle.textContent = open ? "Close" : "Open";
    historyUI.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("history-open", open);
    if (open) {
      ensureHistoryMap();
      if (historyMap && window.google?.maps?.event) {
        google.maps.event.trigger(historyMap, "resize");
      }
      refreshHistoryView();
    }
    setAuthToastVisible(!sessionUser);
    setTapZoneVisible(!walker.activeService);
  }

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
    if (ui.disconnectBtn) ui.disconnectBtn.style.display = isConnected ? '' : 'none';
  }

  const MAX_BACKLOG_M = 200; // cap backlog in meters to avoid runaway

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
      onSensorDistanceDelta(delta * 0.9); // scale by 0.9 because sensor is too fast.
      renderMetrics(walker.sensors, walker);
    }
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
    const heading = pano.getPov()?.heading || 0;
    saveLastPositionFor(sessionUser?.userId, { ...currentPos, heading });
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
      updateHudTitleVisibility(speedKmh);
      session.prevTimeMs = now;
      session.distSincePrevTimeM = 0;
    }

    putMarker(session.prevPosition);
    session.prevPosition = currentPos;
    // Persist status and history at different intervals (no time fallback)
    const STATUS_SAVE_DISTANCE_M = 100;
    const HISTORY_SAVE_DISTANCE_M = 100;
    if (sessionUser) {
      if (session.ignoreNextHistorySave) {
        session.lastStatusSaved = { ...currentPos };
        session.lastHistorySaved = { ...currentPos };
        session.ignoreNextHistorySave = false;
      } else {
        const statusChanged = !session.lastStatusSaved
          || distMeters(session.lastStatusSaved, currentPos) >= STATUS_SAVE_DISTANCE_M;
        if (statusChanged) {
          session.lastStatusSaved = { ...currentPos };
          saveStatus({ ...currentPos, heading });
        }
        const historyChanged = !session.lastHistorySaved
          || distMeters(session.lastHistorySaved, currentPos) >= HISTORY_SAVE_DISTANCE_M;
        if (historyChanged) {
          session.lastHistorySaved = { ...currentPos };
          appendHistory({ ...currentPos, heading, ts: Date.now() });
        }
      }
    }
  });

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
  const ddKey = (dStr) => `dailyDistance:${sessionUser?.userId || 'anon'}:${dStr}`;
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

  // Load today's history and draw markers on mini map (no distance calc)
  async function loadHistoryAndMarkers() {
    const todayStr = session.dayStr;
    try {
      const res = await fetch(`/api/history?day=${todayStr}`);
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
  if (sessionUser) await loadHistoryAndMarkers();
  if (sessionUser) await refreshPasskeys();
  function refreshPanoLayout() {
    if (!pano || !window.google?.maps?.event) return;
    try { google.maps.event.trigger(pano, "resize"); } catch {}
    try {
      const pos = pano.getPosition();
      if (pos) pano.setPosition(pos);
      const pov = pano.getPov();
      if (pov) pano.setPov({ heading: pov.heading || 0, pitch: pov.pitch || 0, zoom: pov.zoom || 1 });
    } catch {}
  }
  // Side pane toggle: hidden by default; show with side-open on all screens
  ui.togglePane.addEventListener('click', () => {
    document.body.classList.toggle('side-open');
    requestAnimationFrame(() => refreshPanoLayout());
  });

  if (historyUI.toggle) {
    historyUI.toggle.addEventListener('click', () => {
      const nextOpen = !historyUI.body?.classList.contains("open");
      setHistoryOpen(nextOpen);
    });
  }
  if (historyUI.modeDay) historyUI.modeDay.addEventListener("click", () => { historyMode = "day"; updateHistoryModeButtons(); refreshHistoryView(); });
  if (historyUI.modeWeek) historyUI.modeWeek.addEventListener("click", () => { historyMode = "week"; updateHistoryModeButtons(); refreshHistoryView(); });
  if (historyUI.modeMonth) historyUI.modeMonth.addEventListener("click", () => { historyMode = "month"; updateHistoryModeButtons(); refreshHistoryView(); });
  if (historyUI.prevBtn) historyUI.prevBtn.addEventListener("click", () => { shiftHistoryPeriod(-1); refreshHistoryView(); });
  if (historyUI.nextBtn) historyUI.nextBtn.addEventListener("click", () => { shiftHistoryPeriod(1); refreshHistoryView(); });
  if (historyUI.inputDay) historyUI.inputDay.addEventListener("change", () => refreshHistoryView());
  if (historyUI.inputWeek) historyUI.inputWeek.addEventListener("change", () => refreshHistoryView());
  if (historyUI.inputMonth) historyUI.inputMonth.addEventListener("change", () => refreshHistoryView());
  if (historyUI.inputDay) historyUI.inputDay.value = session.dayStr;
  if (historyUI.inputWeek) historyUI.inputWeek.value = session.dayStr;
  if (historyUI.inputMonth) historyUI.inputMonth.value = session.dayStr.slice(0, 7);
  updateHistoryModeButtons();

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
