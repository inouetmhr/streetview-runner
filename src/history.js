import { requireSession, authedWrite } from "./auth.js";
import {
  json,
  safeJson,
  today,
  isValidDayString,
  isPlausibleRideDay,
  isPlausibleTs,
  isValidLatLng,
  normalizeHistoryRange,
  summarizeHistory,
} from "./lib.js";

// ---------- D1 access ----------
function dayHistoryStatement(env, userId, day) {
  return env.SVR_DB
    .prepare("SELECT lat, lng, heading, ts FROM history WHERE user_id = ?1 AND day = ?2 ORDER BY ts ASC")
    .bind(userId, day);
}

async function getHistoryFromD1(env, userId, day) {
  const res = await dayHistoryStatement(env, userId, day).all();
  return Array.isArray(res?.results) ? res.results : [];
}

async function getHistoryRangeFromD1(env, userId, fromDay, toDay) {
  const res = await env.SVR_DB
    .prepare("SELECT day, lat, lng, heading, ts FROM history WHERE user_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day ASC, ts ASC")
    .bind(userId, fromDay, toDay)
    .all();
  return Array.isArray(res?.results) ? res.results : [];
}

// ORDER BY day, ts so the (user_id, day, ts) index serves the query.
function latestHistoryStatement(env, userId) {
  return env.SVR_DB
    .prepare("SELECT lat, lng, heading, ts FROM history WHERE user_id = ?1 ORDER BY day DESC, ts DESC LIMIT 1")
    .bind(userId);
}

// Latest point and the given day's points in one D1 round trip.
async function getStatusFromD1(env, userId, day) {
  const [latest, dayItems] = await env.SVR_DB.batch([
    latestHistoryStatement(env, userId),
    dayHistoryStatement(env, userId, day),
  ]);
  return {
    status: latest?.results?.[0] || null,
    items: Array.isArray(dayItems?.results) ? dayItems.results : [],
  };
}

async function putHistoryToD1(env, userId, day, item) {
  await env.SVR_DB
    .prepare("INSERT INTO history (user_id, day, ts, lat, lng, heading) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(userId, day, item.ts, item.lat, item.lng, item.heading)
    .run();
}

// ---------- Handlers ----------
async function getStatus({ env, url, userId }) {
  const day = (url.searchParams.get("day") || today()).trim();
  if (!isPlausibleRideDay(day)) return json({ error: "invalid day" }, 400);
  let status = null;
  let dailyDistanceMeters = 0;
  if (env.SVR_DB) {
    const res = await getStatusFromD1(env, userId, day);
    status = res.status;
    dailyDistanceMeters = summarizeHistory(res.items).distanceMeters || 0;
  }
  return json({ ok: true, status: status || null, dailyDistanceMeters, day });
}

async function getHistory({ env, url, userId }) {
  const { searchParams } = url;
  if (!env.SVR_DB) return json({ ok: true, items: [], summary: { distanceMeters: 0, count: 0 } });
  const fromParam = (searchParams.get("from") || "").trim();
  const toParam = (searchParams.get("to") || "").trim();
  let items;
  if (fromParam || toParam) {
    const range = normalizeHistoryRange(fromParam, toParam);
    if (!range) return json({ error: "invalid date range" }, 400);
    items = await getHistoryRangeFromD1(env, userId, range.from, range.to);
  } else {
    const day = (searchParams.get("day") || today()).trim();
    if (!isValidDayString(day)) return json({ error: "invalid day" }, 400);
    items = await getHistoryFromD1(env, userId, day);
  }
  return json({ ok: true, items, summary: summarizeHistory(items) });
}

async function postHistory({ request, env, userId }) {
  const body = await safeJson(request);
  if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
  const { point } = body;
  if (!point || typeof point !== "object") return json({ error: "point required" }, 400);
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (point.lat == null || point.lng == null || !isValidLatLng(lat, lng)) {
    return json({ error: "valid lat,lng required" }, 400);
  }
  const day = point.day == null ? today() : String(point.day).trim();
  if (!isPlausibleRideDay(day)) return json({ error: "invalid day" }, 400);
  const ts = point.ts == null ? Date.now() : Number(point.ts);
  if (!isPlausibleTs(ts)) return json({ error: "invalid ts" }, 400);
  const heading = Number(point.heading);
  const item = { lat, lng, heading: Number.isFinite(heading) ? heading : 0, ts };
  if (env.SVR_DB) {
    await putHistoryToD1(env, userId, day, item);
  }
  return json({ ok: true });
}

export const HISTORY_ROUTES = {
  "/api/status": { GET: requireSession(getStatus) },
  "/api/history": { GET: requireSession(getHistory), POST: authedWrite(postHistory) },
};
