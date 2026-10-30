/* Small DOM helpers and constants shared by the UI modules */

export const MAP_ID = "fcf78f824472c3b8";

export function qs(id) { return document.getElementById(id); }

const NOTICE_MS = 4000;
let noticeTimer = 0;

// Shows a short message at the top of the screen; kind "error" styles it red.
export function notify(message, { kind = "info" } = {}) {
  const el = qs("notice");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove("show"), NOTICE_MS);
}
