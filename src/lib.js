import { distMeters, MAX_SEGMENT_M } from "../public/geo.js";

export { distMeters };

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 31;
const MAX_TS_SKEW_MS = DAY_MS;

export async function safeJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function today() { return new Date().toISOString().slice(0, 10); }

export function isValidDayString(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}

// Clients send their local "ride day"; accept it only within ±1 day of the server's UTC day.
export function isPlausibleRideDay(day, now = Date.now()) {
  if (!isValidDayString(day)) return false;
  const serverDay = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const diff = Date.parse(`${day}T00:00:00Z`) - serverDay;
  return Math.abs(diff) <= DAY_MS;
}

export function isPlausibleTs(ts, now = Date.now()) {
  return Number.isFinite(ts) && Math.abs(ts - now) <= MAX_TS_SKEW_MS;
}

export function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Returns { from, to } or null when invalid or wider than MAX_RANGE_DAYS (inclusive).
export function normalizeHistoryRange(fromParam, toParam) {
  const from = fromParam || toParam;
  const to = toParam || fromParam;
  if (!from || !to) return null;
  if (!isValidDayString(from) || !isValidDayString(to)) return null;
  if (from > to) return null;
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (spanDays > MAX_RANGE_DAYS) return null;
  return { from, to };
}

export function summarizeHistory(items) {
  if (!Array.isArray(items) || items.length < 2) {
    return { distanceMeters: 0, count: Array.isArray(items) ? items.length : 0 };
  }
  let distanceMeters = 0;
  let prev = null;
  for (const item of items) {
    if (!item || !isFinite(item.lat) || !isFinite(item.lng)) continue;
    const current = { lat: Number(item.lat), lng: Number(item.lng) };
    if (prev) {
      const seg = distMeters(prev, current);
      if (seg <= MAX_SEGMENT_M) {
        distanceMeters += seg;
      }
    }
    prev = current;
  }
  return { distanceMeters, count: items.length };
}

// Base64URL helpers (Uint8Array <-> base64url string)
export function toBase64URL(data) {
  let bytes = data;
  if (Array.isArray(data)) bytes = new Uint8Array(data);
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function fromBase64URL(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s + pad);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toBase64URL(a);
}

export function getCookie(request, name) {
  const h = request.headers.get("cookie") || "";
  for (const p of h.split(/;\s*/)) {
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    if (k === name) return i < 0 ? "" : p.slice(i + 1);
  }
  return null;
}

export function originOk(request, url) {
  const origin = request.headers.get("origin");
  // Some tools may not send Origin; only enforce when present
  if (origin && origin !== url.origin) return false;
  return true;
}
