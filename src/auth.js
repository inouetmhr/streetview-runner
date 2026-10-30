import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  json,
  safeJson,
  isJsonRequest,
  toBase64URL,
  fromBase64URL,
  randomToken,
  getCookie,
  originOk,
} from "./lib.js";

const RP_NAME = "Street View Runner";
const SESSION_COOKIE_NAME = "svr_session";
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365; // ~1y
const SESSION_RENEW_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // slide expiry at most once per 30 days
const CHALLENGE_TTL_S = 600;

// ---------- KV keys & storage ----------
function userKey(userId) { return `user:v1:${userId}`; }
function credKey(credId) { return `cred:v1:${credId}`; }
function regChallengeKey(flowId) { return `challenge:v1:reg:${flowId}`; }
function passkeyAddChallengeKey(flowId) { return `challenge:v1:passkey:${flowId}`; }
function authFlowKey(flowId) { return `challenge:v1:auth:${flowId}`; }
function sessionKey(token) { return `sess:v1:${token}`; }

async function getKV(env, key) {
  if (!env.SVR_KV) return null;
  return await env.SVR_KV.get(key, { type: "json" });
}

async function putKV(env, key, value, options = {}) {
  if (!env.SVR_KV) return;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  await env.SVR_KV.put(key, body, options);
}

async function delKV(env, key) {
  if (!env.SVR_KV) return;
  await env.SVR_KV.delete(key);
}

async function getUser(env, userId) {
  return await getKV(env, userKey(userId));
}

// Challenges are single-use: read and delete before verification so a
// failed or replayed response can never reuse the same flow.
async function takeFlow(env, key) {
  const flow = await getKV(env, key);
  if (flow) await delKV(env, key);
  return flow;
}

// ---------- Sessions ----------
function sessionCookie(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`;
}
const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function putSession(env, token, session) {
  await putKV(env, sessionKey(token), session, { expirationTtl: SESSION_MAX_AGE_S });
}

async function createSession(env, userId, credentialId) {
  const token = randomToken();
  const now = Date.now();
  await putSession(env, token, { userId, credentialId, createdAt: now, renewedAt: now });
  return sessionCookie(token);
}

function hasCredential(user, credentialId) {
  return (user.credentials || []).some((cred) => normalizeCredentialIdString(cred.id) === credentialId);
}

// ---------- Handler wrappers ----------
// Handlers receive ctx = { request, env, url, responseHeaders }; wrappers may add
// to ctx.responseHeaders (e.g. a renewed session cookie) and the router copies them out.

export function withOrigin(fn) {
  return (ctx) => {
    if (!originOk(ctx.request, ctx.url)) return json({ error: "bad origin" }, 400);
    if (ctx.request.headers.has("content-type") && !isJsonRequest(ctx.request)) {
      return json({ error: "content-type must be application/json" }, 415);
    }
    return fn(ctx);
  };
}

// Resolves the session and its user. A session is only valid while its passkey
// is still registered, so removing a passkey signs out the devices that used it.
export function requireSession(fn) {
  return async (ctx) => {
    const { request, env } = ctx;
    const token = getCookie(request, SESSION_COOKIE_NAME);
    const session = token ? await getKV(env, sessionKey(token)) : null;
    if (!session?.userId) return json({ error: "unauthorized" }, 401);
    const user = await getUser(env, session.userId);
    if (!user || !hasCredential(user, normalizeCredentialIdString(session.credentialId))) {
      await delKV(env, sessionKey(token));
      return json({ error: "unauthorized" }, 401, { "Set-Cookie": CLEAR_SESSION_COOKIE });
    }
    const lastRenewed = session.renewedAt || session.createdAt || 0;
    if (Date.now() - lastRenewed > SESSION_RENEW_AFTER_MS) {
      session.renewedAt = Date.now();
      await putSession(env, token, session);
      ctx.responseHeaders.append("Set-Cookie", sessionCookie(token));
    }
    return fn({ ...ctx, session, user, userId: session.userId });
  };
}

// Fixed-window limit via a Workers Rate Limiting binding; skipped when the
// binding is absent (tests, or an environment without [[ratelimits]]).
export function withRateLimit(bindingName, keyFn) {
  return (fn) => async (ctx) => {
    const limiter = ctx.env[bindingName];
    if (limiter) {
      const { success } = await limiter.limit({ key: keyFn(ctx) });
      if (!success) return json({ error: "too many requests" }, 429, { "Retry-After": "60" });
    }
    return fn(ctx);
  };
}

export const byClientIp = (ctx) => ctx.request.headers.get("cf-connecting-ip") || "unknown";
export const byUser = (ctx) => ctx.userId;
const limitAuth = withRateLimit("AUTH_LIMITER", byClientIp);
export const limitWrites = withRateLimit("WRITE_LIMITER", byUser);

// ---------- Helpers ----------
function sanitizeUsername(s) {
  const t = String(s || "").trim().slice(0, 32);
  return t || "Runner";
}

function sanitizePasskeyLabel(s) {
  const t = String(s || "").trim().slice(0, 64);
  return t || null;
}

function generateUsername() {
  return "Runner-" + randomToken(6);
}

function utf8ToBytes(s) {
  return new TextEncoder().encode(String(s));
}

function normalizeCredentialIdString(id) {
  if (typeof id === "string") return id;
  if (id instanceof ArrayBuffer) return toBase64URL(new Uint8Array(id));
  if (ArrayBuffer.isView(id)) {
    return toBase64URL(new Uint8Array(id.buffer, id.byteOffset, id.byteLength));
  }
  return "";
}

function userResponse(user, headers) {
  return json({ ok: true, user: { userId: user.userId, username: user.username } }, 200, headers);
}

function passkeyListResponse(user, session) {
  const items = (user.credentials || []).map((cred) => ({
    id: normalizeCredentialIdString(cred.id),
    transports: cred.transports || undefined,
    label: cred.label || undefined,
  }));
  return json({ ok: true, items, currentCredentialId: normalizeCredentialIdString(session?.credentialId) || null });
}

function registrationOptionsFor(url, userId, username, excludeCredentials = []) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: url.hostname,
    userName: username,
    userID: utf8ToBytes(userId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials,
  });
}

// Verifies an attestation and returns the credential record to store, or null.
async function verifyNewCredential(url, flow, body) {
  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: flow.challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: false,
  });
  const info = verification.verified ? verification.registrationInfo : null;
  if (!info?.credential?.id || !info.credential.publicKey) return null;
  return {
    id: info.credential.id,
    publicKey: toBase64URL(info.credential.publicKey),
    counter: info.credential.counter || 0,
    transports: info.credential.transports || undefined,
    label: sanitizePasskeyLabel(body.passkeyLabel) || undefined,
  };
}

async function readFlowBody(request) {
  const body = await safeJson(request);
  if (!body || !body.flowId || !body.response) return null;
  return body;
}

// ---------- Handlers ----------
// Handlers behind requireSession get the already-loaded `user` from ctx.
async function sessionInfo({ user }) {
  return userResponse(user);
}

async function updateUsername({ request, env, userId, user }) {
  const body = await safeJson(request);
  const username = sanitizeUsername(body?.username || "");
  user.username = username;
  await putKV(env, userKey(userId), user);
  return userResponse(user);
}

async function registerOptions({ request, env, url }) {
  const body = await safeJson(request);
  const username = sanitizeUsername(body?.username || generateUsername());
  const userId = crypto.randomUUID();
  const options = await registrationOptionsFor(url, userId, username);
  const flowId = randomToken();
  await putKV(env, regChallengeKey(flowId), { challenge: options.challenge, userId, username, createdAt: Date.now() }, { expirationTtl: CHALLENGE_TTL_S });
  return json({ ok: true, options, flowId });
}

async function registerVerify({ request, env, url }) {
  const body = await readFlowBody(request);
  if (!body) return json({ error: "invalid json" }, 400);
  const flow = await takeFlow(env, regChallengeKey(String(body.flowId)));
  if (!flow) return json({ error: "invalid flow" }, 400);
  try {
    const credential = await verifyNewCredential(url, flow, body);
    if (!credential) return json({ error: "verification failed" }, 400);
    const user = {
      userId: flow.userId,
      username: flow.username,
      createdAt: Date.now(),
      credentials: [credential],
    };
    console.log("New user registered:", user.userId);
    await putKV(env, userKey(user.userId), user);
    await putKV(env, credKey(credential.id), { userId: user.userId });
    const cookie = await createSession(env, user.userId, credential.id);
    return userResponse(user, { "Set-Cookie": cookie });
  } catch (e) {
    console.error("reg verify error", e);
    return json({ error: "verification error" }, 400);
  }
}

async function passkeyAddOptions({ env, url, userId, user }) {
  const excludeCredentials = (user.credentials || [])
    .map((cred) => {
      const id = normalizeCredentialIdString(cred.id);
      return id ? { id, type: "public-key", transports: cred.transports || undefined } : null;
    })
    .filter(Boolean);
  const options = await registrationOptionsFor(url, user.userId, user.username || "Runner", excludeCredentials);
  const flowId = randomToken();
  await putKV(env, passkeyAddChallengeKey(flowId), { challenge: options.challenge, userId, createdAt: Date.now() }, { expirationTtl: CHALLENGE_TTL_S });
  return json({ ok: true, options, flowId });
}

async function passkeyAddVerify({ request, env, url, userId, user }) {
  const body = await readFlowBody(request);
  if (!body) return json({ error: "invalid json" }, 400);
  const flow = await takeFlow(env, passkeyAddChallengeKey(String(body.flowId)));
  if (!flow) return json({ error: "invalid flow" }, 400);
  if (flow.userId !== userId) return json({ error: "invalid session" }, 400);
  try {
    const credential = await verifyNewCredential(url, flow, body);
    if (!credential) return json({ error: "verification failed" }, 400);
    user.credentials = user.credentials || [];
    if (user.credentials.some((cred) => cred.id === credential.id)) {
      return json({ error: "credential already registered" }, 400);
    }
    user.credentials.push(credential);
    await putKV(env, userKey(user.userId), user);
    await putKV(env, credKey(credential.id), { userId: user.userId });
    return userResponse(user);
  } catch (e) {
    console.error("passkey add verify error", e);
    return json({ error: "verification error" }, 400);
  }
}

async function passkeyList({ user, session }) {
  return passkeyListResponse(user, session);
}

async function passkeyDelete({ request, env, user, session }) {
  const body = await safeJson(request);
  const credentialId = String(body?.credentialId || "");
  if (!credentialId) return json({ error: "missing credential id" }, 400);
  const creds = Array.isArray(user.credentials) ? user.credentials : [];
  if (creds.length <= 1) return json({ error: "last passkey cannot be removed" }, 400);
  const next = creds.filter((cred) => normalizeCredentialIdString(cred.id) !== credentialId);
  if (next.length === creds.length) return json({ error: "credential not found" }, 404);
  user.credentials = next;
  await putKV(env, userKey(user.userId), user);
  await delKV(env, credKey(credentialId));
  return passkeyListResponse(user, session);
}

async function passkeyLabel({ request, env, user, session }) {
  const body = await safeJson(request);
  const credentialId = String(body?.credentialId || "");
  const label = sanitizePasskeyLabel(body?.label);
  if (!credentialId) return json({ error: "missing credential id" }, 400);
  if (!label) return json({ error: "invalid label" }, 400);
  const target = (user.credentials || []).find((cred) => normalizeCredentialIdString(cred.id) === credentialId);
  if (!target) return json({ error: "credential not found" }, 404);
  target.label = label;
  await putKV(env, userKey(user.userId), user);
  return passkeyListResponse(user, session);
}

async function loginOptions({ env, url }) {
  const options = await generateAuthenticationOptions({
    rpID: url.hostname,
    userVerification: "preferred",
    allowCredentials: [],
  });
  const flowId = randomToken();
  await putKV(env, authFlowKey(flowId), { challenge: options.challenge, createdAt: Date.now() }, { expirationTtl: CHALLENGE_TTL_S });
  return json({ ok: true, options, flowId });
}

async function loginVerify({ request, env, url }) {
  const body = await readFlowBody(request);
  if (!body) return json({ error: "invalid json" }, 400);
  const credentialId = String(body.response?.id || "");
  if (!credentialId) return json({ error: "missing credential id" }, 400);
  const flow = await takeFlow(env, authFlowKey(String(body.flowId)));
  if (!flow?.challenge) return json({ error: "invalid flow" }, 400);
  try {
    const link = await getKV(env, credKey(credentialId));
    if (!link) return json({ error: "unknown credential" }, 400);
    const user = await getUser(env, link.userId);
    if (!user) return json({ error: "unknown user" }, 400);
    const cred = (user.credentials || []).find((c) => normalizeCredentialIdString(c.id) === credentialId);
    if (!cred) return json({ error: "credential not linked" }, 400);
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      credential: { id: cred.id, publicKey: fromBase64URL(cred.publicKey), counter: cred.counter },
    });
    if (!verification.verified) return json({ error: "verification failed" }, 400);
    cred.counter = verification.authenticationInfo.newCounter || cred.counter;
    await putKV(env, userKey(user.userId), user);
    console.log("User logged in:", user.userId);
    const cookie = await createSession(env, user.userId, credentialId);
    return userResponse(user, { "Set-Cookie": cookie });
  } catch (e) {
    console.error("auth verify error", e);
    return json({ error: "verification error" }, 400);
  }
}

async function logout({ request, env }) {
  const token = getCookie(request, SESSION_COOKIE_NAME);
  if (token) await delKV(env, sessionKey(token));
  return json({ ok: true }, 200, { "Set-Cookie": CLEAR_SESSION_COOKIE });
}

// Signed-in state changes: origin check, session, then a per-user write limit.
export const authedWrite = (fn) => withOrigin(requireSession(limitWrites(fn)));
// Unauthenticated auth steps write challenges/users to KV: limit per client IP.
const publicAuth = (fn) => withOrigin(limitAuth(fn));

export const AUTH_ROUTES = {
  "/api/auth/session": { GET: requireSession(sessionInfo) },
  "/api/auth/username": { POST: authedWrite(updateUsername) },
  "/api/auth/register/options": { POST: publicAuth(registerOptions) },
  "/api/auth/register/verify": { POST: publicAuth(registerVerify) },
  "/api/auth/passkeys": { GET: requireSession(passkeyList) },
  "/api/auth/passkeys/options": { POST: authedWrite(passkeyAddOptions) },
  "/api/auth/passkeys/verify": { POST: authedWrite(passkeyAddVerify) },
  "/api/auth/passkeys/delete": { POST: authedWrite(passkeyDelete) },
  "/api/auth/passkeys/label": { POST: authedWrite(passkeyLabel) },
  "/api/auth/login/options": { POST: publicAuth(loginOptions) },
  "/api/auth/login/verify": { POST: publicAuth(loginVerify) },
  "/api/auth/logout": { POST: withOrigin(logout) },
};
