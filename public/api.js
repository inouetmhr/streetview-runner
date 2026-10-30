/* Worker API client: status, history and passkey auth */

// Self-hosted copy (see `npm run vendor`) so no third-party CDN code runs on the signed-in page.
const SIMPLEWEBAUTHN_BROWSER_URL = "./vendor/simplewebauthn-browser.js";

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) return null;
  return await res.json();
}

// POST JSON; returns { ok, status, data } and never throws on HTTP errors.
async function postJson(path, body) {
  const init = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function fetchStatus(day) {
  try {
    const data = await getJson(`/api/status?${new URLSearchParams({ day })}`);
    if (!data?.ok) return null;
    return {
      status: data.status || null,
      dailyDistanceMeters: Number.isFinite(data.dailyDistanceMeters) ? data.dailyDistanceMeters : null,
      day: data.day || null,
    };
  } catch { return null; }
}

export async function appendHistory(point) {
  try { await postJson("/api/history", { point }); } catch {}
}

export async function fetchHistoryDay(day) {
  try { return await getJson(`/api/history?${new URLSearchParams({ day })}`); } catch { return null; }
}

export async function fetchHistoryRange(from, to) {
  try { return await getJson(`/api/history?${new URLSearchParams({ from, to })}`); } catch { return null; }
}

export async function getSession() {
  try { return (await getJson("/api/auth/session"))?.user || null; } catch { return null; }
}

// Turns a failed passkey step into a message for the user.
function authErrorMessage(e, res) {
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return "Passkey request was cancelled or timed out.";
  if (e?.name === "InvalidStateError") return "This device already has a passkey for this account.";
  if (res?.status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (res?.data?.error) return `Sign-in failed: ${res.data.error}.`;
  if (e instanceof TypeError) return "Network error. Check your connection and try again.";
  return "Sign-in failed. Please try again.";
}

// Runs options → browser ceremony → verify. Returns { user } or { error }.
async function passkeyFlow(optionsPath, verifyPath, ceremony, extraBody = {}) {
  let res = null;
  try {
    res = await postJson(optionsPath, extraBody.optionsBody);
    if (!res.ok) return { error: authErrorMessage(null, res) };
    const { options, flowId } = res.data;
    const browser = await import(SIMPLEWEBAUTHN_BROWSER_URL);
    const response = await ceremony(browser, options);
    res = await postJson(verifyPath, { flowId, response, ...extraBody.verifyBody });
    if (!res.ok) return { error: authErrorMessage(null, res) };
    return { user: res.data?.user || null };
  } catch (e) {
    console.warn("passkey flow error", e);
    return { error: authErrorMessage(e, null) };
  }
}

export function registerWithPasskey(username) {
  return passkeyFlow(
    "/api/auth/register/options",
    "/api/auth/register/verify",
    (b, optionsJSON) => b.startRegistration({ optionsJSON }),
    { optionsBody: { username }, verifyBody: { passkeyLabel: suggestPasskeyLabel() } },
  );
}

export function addPasskey() {
  return passkeyFlow(
    "/api/auth/passkeys/options",
    "/api/auth/passkeys/verify",
    (b, optionsJSON) => b.startRegistration({ optionsJSON }),
    { verifyBody: { passkeyLabel: suggestPasskeyLabel() } },
  );
}

export function loginWithPasskey() {
  return passkeyFlow(
    "/api/auth/login/options",
    "/api/auth/login/verify",
    (b, optionsJSON) => b.startAuthentication({ optionsJSON }),
  );
}

export async function logoutSession() {
  try { await postJson("/api/auth/logout"); } catch {}
}

export async function updateUsername(username) {
  try {
    const res = await postJson("/api/auth/username", { username });
    return res.ok ? res.data?.user || null : null;
  } catch { return null; }
}

function toPasskeyList(data) {
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    currentCredentialId: data?.currentCredentialId || null,
  };
}

export async function fetchPasskeys() {
  try { return toPasskeyList(await getJson("/api/auth/passkeys")); } catch { return toPasskeyList(null); }
}

// Returns { ok:true, items, currentCredentialId } or { ok:false, error }
async function postPasskeyChange(path, body) {
  try {
    const res = await postJson(path, body);
    if (!res.ok) return { ok: false, error: res.data };
    return { ok: true, ...toPasskeyList(res.data) };
  } catch {
    return { ok: false, error: null };
  }
}

export function deletePasskey(credentialId) {
  return postPasskeyChange("/api/auth/passkeys/delete", { credentialId });
}

export function renamePasskey(credentialId, label) {
  return postPasskeyChange("/api/auth/passkeys/label", { credentialId, label });
}

function suggestPasskeyLabel() {
  const ua = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isIpad = /iPad/i.test(ua);
  const isIphone = /iPhone/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isWindows = /Win/i.test(platform);
  const isMac = /Mac/i.test(platform) && !isIOS;
  const isChromeOS = /CrOS/i.test(ua);
  let device = "Device";
  if (isIphone) device = "iPhone";
  else if (isIpad) device = "iPad";
  else if (isIOS) device = "iOS device";
  else if (isAndroid) device = /Mobile/i.test(ua) ? "Android phone" : "Android device";
  else if (isMac) device = "Mac";
  else if (isWindows) device = "Windows PC";
  else if (isChromeOS) device = "Chromebook";
  const day = new Date().toISOString().slice(0, 10);
  return `${device} (${day})`;
}
