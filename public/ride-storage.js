/* localStorage persistence of the last position and daily distance, scoped per user */

const lastPositionKey = (userId) => `lastPosition:${userId || "anon"}`;
const dailyDistanceKey = (userId, day) => `dailyDistance:${userId || "anon"}:${day}`;

export function loadLastPosition(userId) {
  try {
    const raw = localStorage.getItem(lastPositionKey(userId));
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
}

export function saveLastPosition(userId, pos) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
  const next = {
    lat: pos.lat,
    lng: pos.lng,
    heading: Number.isFinite(pos.heading) ? pos.heading : 0,
    ts: Number.isFinite(pos.ts) ? pos.ts : Date.now(),
  };
  try { localStorage.setItem(lastPositionKey(userId), JSON.stringify(next)); } catch {}
}

// Picks whichever of the local and server positions is newer.
export function resolveLatestPosition(localPos, serverPos) {
  if (!localPos) return { pos: serverPos || null, preferLocal: false };
  if (!serverPos) return { pos: localPos, preferLocal: true };
  const localTs = Number.isFinite(localPos.ts) ? localPos.ts : 0;
  const serverTs = Number.isFinite(serverPos.ts) ? serverPos.ts : 0;
  const preferLocal = localTs > serverTs;
  return { pos: preferLocal ? localPos : serverPos, preferLocal };
}

export function loadDailyDistance(userId, day) {
  try {
    const v = parseFloat(localStorage.getItem(dailyDistanceKey(userId, day)) ?? "");
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

export function saveDailyDistance(userId, day, meters) {
  try { localStorage.setItem(dailyDistanceKey(userId, day), String(meters)); } catch {}
}
