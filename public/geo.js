/* Geometry and date helpers shared by the browser app and the Worker. */

// Path segments longer than this are treated as "warps" (manual jumps) and excluded.
export const MAX_SEGMENT_M = 500;

// A "ride day" is the user's local calendar day, rolling over at DAY_ROLLOVER_HOUR
// so late-night rides still count toward the previous day.
export const DAY_ROLLOVER_HOUR = 3;

// Haversine distance
export function distMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Split a point list into polylines, breaking at jumps longer than MAX_SEGMENT_M.
export function splitSegments(points) {
  const segments = [];
  if (!points.length) return segments;
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (distMeters(points[i - 1], points[i]) <= MAX_SEGMENT_M) {
      current.push(points[i]);
    } else {
      if (current.length >= 2) segments.push(current);
      current = [points[i]];
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

export function angleDelta(a, b) {
  return ((b - a + 540) % 360) - 180; // in [-180, 180)
}

export function blendHeading(current, target, factor) {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target)) return current;
  return (current + angleDelta(current, target) * factor + 360) % 360;
}

export function stepHeadingToward(current, target, maxStep) {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target)) return current;
  const delta = angleDelta(current, target);
  const step = Math.min(Math.abs(delta), maxStep);
  return (current + Math.sign(delta) * step + 360) % 360;
}

export function chooseForwardLink(pano, baseHeading) {
  const links = pano.getLinks() || [];
  const heading = Number.isFinite(baseHeading) ? baseHeading : (pano.getPov().heading || 0);
  if (!links.length) return null;
  let best = links[0];
  let bestDiff = Infinity;
  for (const l of links) {
    const diff = Math.abs(angleDelta(heading, l.heading || 0));
    if (diff < bestDiff) { bestDiff = diff; best = l; }
  }
  return best;
}

export function rideDay(date = new Date()) {
  const d = new Date(date.getTime() - DAY_ROLLOVER_HOUR * 60 * 60 * 1000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function toDateStringUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateStringUTC(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

export function getWeekRangeUTC(dayStr, firstDayIndex) {
  const base = parseDateStringUTC(dayStr) || parseDateStringUTC(rideDay());
  const dayIndex = base.getUTCDay();
  const diff = (dayIndex - firstDayIndex + 7) % 7;
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - diff);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { from: toDateStringUTC(start), to: toDateStringUTC(end) };
}

export function getMonthRangeUTC(monthStr) {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) {
    monthStr = rideDay().slice(0, 7);
  }
  const [y, m] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { from: toDateStringUTC(start), to: toDateStringUTC(end) };
}
