/* History view: full-size map with the ride polyline for a day/week/month */
import { fetchHistoryRange } from "./api.js";
import {
  splitSegments,
  rideDay,
  toDateStringUTC,
  parseDateStringUTC,
  getWeekRangeUTC,
  getMonthRangeUTC,
} from "./geo.js";
import { qs, MAP_ID } from "./dom.js";

function getLocaleFirstDayIndex() {
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = locale.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch {}
  return 1; // Monday
}

/**
 * Wires the history section of the side pane.
 * - getUser() returns the signed-in user or null.
 * - center is the initial map center before any history is drawn.
 * - onOpenChange(open) runs whenever the view opens or closes.
 * Returns { refresh, isBodyOpen }.
 */
export function createHistoryView({ getUser, center, onOpenChange }) {
  const historyUI = {
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
  const firstDayIndex = getLocaleFirstDayIndex();
  let historyMode = "day";
  let historyMap = null;
  let historyPolylines = [];

  function ensureHistoryMap() {
    if (historyMap || !window.google || !google.maps) return;
    historyMap = new google.maps.Map(qs('historyMap'), {
      center: { lat: center.lat, lng: center.lng },
      zoom: 14,
      clickableIcons: false,
      mapId: MAP_ID,
      fullscreenControl: false,
      streetViewControl: false,
      mapTypeControl: false,
    });
  }

  function clearHistoryPolyline() {
    historyPolylines.forEach((pl) => pl.setMap(null));
    historyPolylines = [];
  }

  function drawHistoryPolyline(items) {
    if (!historyMap) return;
    clearHistoryPolyline();
    const points = items
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!points.length) return;

    for (const path of splitSegments(points)) {
      historyPolylines.push(new google.maps.Polyline({
        path,
        strokeColor: "#2563eb",
        strokeOpacity: 0.9,
        strokeWeight: 4,
        map: historyMap,
      }));
    }

    if (points.length === 1) {
      historyMap.setCenter(points[0]);
      historyMap.setZoom(16);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    historyMap.fitBounds(bounds, 240);
  }

  function updateHistoryModeButtons() {
    const modes = [
      { mode: "day", btn: historyUI.modeDay, input: historyUI.inputDay },
      { mode: "week", btn: historyUI.modeWeek, input: historyUI.inputWeek },
      { mode: "month", btn: historyUI.modeMonth, input: historyUI.inputMonth },
    ];
    modes.forEach(({ mode, btn, input }) => {
      btn?.classList.toggle("active", historyMode === mode);
      if (input) input.style.display = historyMode === mode ? "" : "none";
    });
  }

  function getHistoryRangeFromInputs() {
    if (historyMode === "day") {
      const day = historyUI.inputDay?.value || rideDay();
      return { from: day, to: day };
    }
    if (historyMode === "week") {
      const day = historyUI.inputWeek?.value || rideDay();
      return getWeekRangeUTC(day, firstDayIndex);
    }
    const month = historyUI.inputMonth?.value || rideDay().slice(0, 7);
    return getMonthRangeUTC(month);
  }

  function shiftHistoryPeriod(direction) {
    if (historyMode === "day" || historyMode === "week") {
      const input = historyMode === "day" ? historyUI.inputDay : historyUI.inputWeek;
      const stepDays = historyMode === "day" ? 1 : 7;
      const base = parseDateStringUTC(input?.value || rideDay()) || parseDateStringUTC(rideDay());
      base.setUTCDate(base.getUTCDate() + direction * stepDays);
      if (input) input.value = toDateStringUTC(base);
      return;
    }
    const monthStr = historyUI.inputMonth?.value || rideDay().slice(0, 7);
    const [y, m] = monthStr.split("-").map(Number);
    const next = new Date(Date.UTC(y, (m - 1) + direction, 1));
    const nextStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    if (historyUI.inputMonth) historyUI.inputMonth.value = nextStr;
  }

  function showEmpty(message) {
    historyUI.status.textContent = message;
    historyUI.range.textContent = "—";
    historyUI.distance.textContent = "—";
    clearHistoryPolyline();
  }

  const isBodyOpen = () => !!historyUI.body?.classList.contains("open");

  async function refresh() {
    if (!isBodyOpen()) return;
    if (!historyUI.status || !historyUI.range || !historyUI.distance) return;
    if (!getUser()) return showEmpty("Sign in to view history.");
    const range = getHistoryRangeFromInputs();
    if (!range?.from || !range?.to) return showEmpty("Invalid date.");
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
    historyUI.distance.textContent = Number.isFinite(distanceMeters)
      ? `${(distanceMeters / 1000).toFixed(2)} km`
      : "—";
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
    historyUI.body.classList.toggle("open", open);
    historyUI.toggle.textContent = open ? "Close" : "Open";
    historyUI.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("history-open", open);
    if (open) {
      ensureHistoryMap();
      if (historyMap && window.google?.maps?.event) {
        google.maps.event.trigger(historyMap, "resize");
      }
      refresh();
    }
    onOpenChange(open);
  }

  const setMode = (mode) => { historyMode = mode; updateHistoryModeButtons(); refresh(); };
  historyUI.toggle?.addEventListener('click', () => setHistoryOpen(!isBodyOpen()));
  historyUI.modeDay?.addEventListener("click", () => setMode("day"));
  historyUI.modeWeek?.addEventListener("click", () => setMode("week"));
  historyUI.modeMonth?.addEventListener("click", () => setMode("month"));
  historyUI.prevBtn?.addEventListener("click", () => { shiftHistoryPeriod(-1); refresh(); });
  historyUI.nextBtn?.addEventListener("click", () => { shiftHistoryPeriod(1); refresh(); });
  for (const input of [historyUI.inputDay, historyUI.inputWeek, historyUI.inputMonth]) {
    input?.addEventListener("change", () => refresh());
  }
  const today = rideDay();
  if (historyUI.inputDay) historyUI.inputDay.value = today;
  if (historyUI.inputWeek) historyUI.inputWeek.value = today;
  if (historyUI.inputMonth) historyUI.inputMonth.value = today.slice(0, 7);
  updateHistoryModeButtons();

  return { refresh, isBodyOpen };
}
