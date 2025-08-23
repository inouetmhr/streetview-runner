import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log(`Request: ${request.method} ${url.pathname}${url.search}`);

    // Route API requests first
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error("API error", e);
        return json({ error: String(e?.message || e) }, 500);
      }
    }

    // Try to serve static assets (public/*) first
    if (env.ASSETS) {
      // Attempt exact match (e.g., /, /styles.css, /app.js)
      let res = await env.ASSETS.fetch(request);
      if (res.status !== 404) {
        // Inject Google Maps API key into any HTML we return
        if (shouldInjectHtml(res)) {
          return await injectWithRewriter(res, env);
        }
        return res;
      }
    }

    // Last resort: inline HTML fallback (if assets missing)
    return new Response(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cloudflare Worker App</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Apple Color Emoji, Segoe UI Emoji; padding: 2rem; }
      code { background: #f3f4f6; padding: .15rem .35rem; border-radius: .25rem; }
    </style>
  </head>
  <body>
    <h1>Cloudflare Worker App</h1>
    <p>Static assets not found, showing fallback page.</p>
    <p>Available APIs (session required): <code>GET/POST /api/status</code>, <code>GET/POST /api/history?day=YYYY-MM-DD</code>.</p>
  </body>
</html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  },
};

function shouldInjectHtml(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("text/html");
}

async function injectWithRewriter(res, env) {
  const key = env.GOOGLE_MAPS_API_KEY || "";
  const rewriter = new HTMLRewriter()
    .on('script[src*="maps.googleapis.com/maps/api/js"]', {
      element(el) {
        const src = el.getAttribute('src') || '';
        if (src.includes('__GOOGLE_MAPS_API_KEY__')) {
          el.setAttribute('src', src.replaceAll('__GOOGLE_MAPS_API_KEY__', key));
        } else if (key) {
          try {
            const u = new URL(src, 'https://example.com');
            if (!u.searchParams.get('key')) {
              u.searchParams.set('key', key);
              el.setAttribute('src', u.pathname + u.search);
            }
          } catch (_) {
            // ignore invalid URLs
          }
        }
      }
    })
    // Optional: replace any leftover placeholders in text nodes
    .on('body', {
      text(t) {
        const s = t.text || '';
        if (s.includes('__GOOGLE_MAPS_API_KEY__')) {
          t.replace(s.replaceAll('__GOOGLE_MAPS_API_KEY__', key));
        }
      }
    });

  const out = rewriter.transform(res);
  const h = new Headers(out.headers);
  h.delete('content-length');
  h.delete('content-encoding');
  h.delete('etag');
  h.set('content-type', 'text/html; charset=utf-8');
  return new Response(out.body, { status: out.status, headers: h });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// (removed unused leaderboard helpers)

// ----- Status/History API (Firestore/IndexedDB replacement) -----

async function handleApi(request, env, url) {
  const { pathname, searchParams } = url;

  // ---- Auth Endpoints ----
  if (pathname === "/api/auth/session") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
    const userId = await getSessionUserId(request, env);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const user = await getUser(env, userId);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, user: { userId: user.userId, username: user.username } });
  }

  if (pathname === "/api/auth/username") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    if (!originOk(request, url)) return json({ error: "bad origin" }, 400);
    const userId = await getSessionUserId(request, env);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const body = await safeJson(request);
    const username = sanitizeUsername(body?.username || "");
    if (!username) return json({ error: "invalid username" }, 400);
    const user = await getUser(env, userId);
    if (!user) return json({ error: "unknown user" }, 404);
    user.username = username;
    await putKV(env, userKey(userId), user);
    return json({ ok: true, user: { userId, username } });
  }

  if (pathname === "/api/auth/register/options") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    if (!originOk(request, url)) return json({ error: "bad origin" }, 400);
    const body = await safeJson(request);
    const username = sanitizeUsername(body?.username || generateUsername());
    const userId = uuidv4();
    const rpID = url.hostname;
    const options = await generateRegistrationOptions({
      rpName: "Street View Runner",
      rpID,
      userName: username,
      userID: utf8ToBytes(userId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      excludeCredentials: [],
    });
    const flowId = randomToken();
    await putKV(env, regChallengeKey(flowId), { challenge: options.challenge, userId, username, createdAt: Date.now() }, { expirationTtl: 600 });
    return json({ ok: true, options, flowId });
  }

  if (pathname === "/api/auth/register/verify") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    if (!originOk(request, url)) return json({ error: "bad origin" }, 400);
    const body = await safeJson(request);
    if (!body || !body.flowId || !body.response) return json({ error: "invalid json" }, 400);
    const flow = await getKV(env, regChallengeKey(String(body.flowId)));
    if (!flow) return json({ error: "invalid flow" }, 400);
    const rpID = url.hostname;
    const expectedOrigin = url.origin;
    try {
      const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: flow.challenge,
        expectedOrigin,
        expectedRPID: rpID,
      });
      if (!verification.verified) return json({ error: "verification failed" }, 400);
      const { registrationInfo } = verification;
      if (!registrationInfo || !registrationInfo.credential.id || !registrationInfo.credential.publicKey) {
        return json({ error: "invalid registration info" }, 400);
      }
      const credentialID = registrationInfo.credential.id;
      const credentialPublicKey = toBase64URL(registrationInfo.credential.publicKey);
      const counter = registrationInfo.credential.counter || 0;
      // Persist user and credential
      const user = {
        userId: flow.userId,
        username: flow.username,
        createdAt: Date.now(),
        credentials: [ { id: credentialID, publicKey: credentialPublicKey, counter, transports: registrationInfo.transports || undefined } ],
      };
      console.log("New user registered:", user);
      await putKV(env, userKey(user.userId), user);
      await putKV(env, credKey(credentialID), { userId: user.userId });
      // Delete used flow
      await delKV(env, regChallengeKey(String(body.flowId)));
      // Create session
      const { token, cookie } = await createSession(env, user.userId);
      return json({ ok: true, user: { userId: user.userId, username: user.username } }, 200, { "Set-Cookie": cookie });
    } catch (e) {
      console.error("reg verify error", e);
      return json({ error: "verification error" }, 400);
    }
  }

  if (pathname === "/api/auth/login/options") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    if (!originOk(request, url)) return json({ error: "bad origin" }, 400);
    const rpID = url.hostname;
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      allowCredentials: [],
    });
    const flowId = randomToken();
    await putKV(env, authFlowKey(flowId), { challenge: options.challenge, createdAt: Date.now() }, { expirationTtl: 600 });
    return json({ ok: true, options, flowId });
  }

  if (pathname === "/api/auth/login/verify") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    if (!originOk(request, url)) return json({ error: "bad origin" }, 400);
    const body = await safeJson(request);
    if (!body || !body.response || !body.flowId) return json({ error: "invalid json" }, 400);
    const rpID = url.hostname;
    const expectedOrigin = url.origin;
    const credentialId = String(body.response?.id || "");
    if (!credentialId) return json({ error: "missing credential id" }, 400);
    // Load expected challenge via flowId we issued
    const flow = await getKV(env, authFlowKey(String(body.flowId)));
    if (!flow || !flow.challenge) return json({ error: "invalid flow" }, 400);
    const expectedChallenge = flow.challenge;
    try {
      // Find user by credential
      const userId = await getKV(env, credKey(credentialId));
      if (!userId) return json({ error: "unknown credential" }, 400);
      const user = await getUser(env, userId.userId);
      if (!user) return json({ error: "unknown user" }, 400);
      const cred = (user.credentials || []).find(c => c.id === credentialId);
      if (!cred) return json({ error: "credential not linked" }, 400);
      const credential = {
        id: cred.id,
        publicKey: fromBase64URL(cred.publicKey),
        counter: cred.counter,
      };
      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential,
      });
      console.log("Verification result:", verification);
      if (!verification.verified) return json({ error: "verification failed" }, 400);
      const { authenticationInfo } = verification;
      // Update counter
      cred.counter = authenticationInfo.newCounter || cred.counter;
      await putKV(env, userKey(user.userId), user);
      await delKV(env, authFlowKey(String(body.flowId)));
      const { token, cookie } = await createSession(env, user.userId);
      return json({ ok: true, user: { userId: user.userId, username: user.username } }, 200, { "Set-Cookie": cookie });
    } catch (e) {
      console.error("auth verify error", e);
      return json({ error: "verification error" }, 400);
    }
  }

  if (pathname === "/api/auth/logout") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    const token = getCookie(request, SESSION_COOKIE_NAME);
    if (token) await delKV(env, sessionKey(token));
    return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  if (pathname === "/api/status") {
    if (request.method === "GET") {
      const userId = await getSessionUserId(request, env);
      if (!userId) return json({ error: "unauthorized" }, 401);
      const key = statusKey(userId);
      const stored = env.SVR_KV ? await env.SVR_KV.get(key, { type: "json" }) : null;
      const fallback = { lat:35.681296, lng:139.758922, heading: 190, ts: Date.now() }; // otemachi
      //TODO:ここでのfalbackじゃなく、frontend側で画面上の現在位置を使うようにする
      return json({ ok: true, status: stored || fallback });
    }
    if (request.method === "POST") {
      const body = await safeJson(request);
      if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
      const sessionUserId = await getSessionUserId(request, env);
      if (!sessionUserId) return json({ error: "unauthorized" }, 401);
      const { location } = body;
      if (!location || !isFinite(location.lat) || !isFinite(location.lng)) {
        return json({ error: "numeric lat,lng required" }, 400);
      }
      const status = {
        lat: Number(location.lat),
        lng: Number(location.lng),
        heading: isFinite(location.heading) ? Number(location.heading) : 0,
        ts: Date.now(),
      };
      if (env.SVR_KV) {
        await env.SVR_KV.put(statusKey(sessionUserId), JSON.stringify(status));
      }
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405, { Allow: "GET, POST" });
  }

  if (pathname === "/api/history") {
    if (request.method === "GET") {
      const userId = await getSessionUserId(request, env);
      const day = (searchParams.get("day") || today()).trim();
      if (!userId) return json({ error: "unauthorized" }, 401);
      const key = historyKey(userId, day);
      const items = env.SVR_KV ? await env.SVR_KV.get(key, { type: "json" }) : null;
      return json({ ok: true, items: Array.isArray(items) ? items : [] });
    }
    if (request.method === "POST") {
      const body = await safeJson(request);
      if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
      const userId = await getSessionUserId(request, env);
      const { point } = body;
      if (!userId) return json({ error: "unauthorized" }, 401);
      if (!point || !isFinite(point.lat) || !isFinite(point.lng)) {
        return json({ error: "numeric lat,lng required" }, 400);
      }
      const day = point.day || today();
      const item = {
        lat: Number(point.lat),
        lng: Number(point.lng),
        heading: isFinite(point.heading) ? Number(point.heading) : 0,
        ts: isFinite(point.ts) ? Number(point.ts) : Date.now(),
      };
      let arr = [];
      if (env.SVR_KV) {
        const key = historyKey(userId, day);
        const stored = await env.SVR_KV.get(key, { type: "json" });
        arr = Array.isArray(stored) ? stored : [];
        arr.push(item);
        // Keep array from growing unbounded; trim to last N
        const MAX_POINTS = 500;
        if (arr.length > MAX_POINTS) arr = arr.slice(arr.length - MAX_POINTS);
        await env.SVR_KV.put(key, JSON.stringify(arr));
      }
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405, { Allow: "GET, POST" });
  }

  return json({ error: "not found" }, 404);
}

function statusKey(userId) { return `status:v1:${userId}`; }
function historyKey(userId, day) { return `history:v1:${userId}:${day}`; }
function today() { return new Date().toISOString().slice(0, 10); }

// ---------- Auth helpers & storage ----------
const SESSION_COOKIE_NAME = "svr_session";

async function getSessionUserId(request, env) {
  const token = getCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const sess = await getKV(env, sessionKey(token));
  return sess?.userId || null;
}

async function createSession(env, userId) {
  const token = randomToken();
  const now = Date.now();
  await putKV(env, sessionKey(token), { userId, createdAt: now });
  const maxAge = 60 * 60 * 24 * 365; // ~1y
  const cookie = `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  return { token, cookie };
}

function getCookie(request, name) {
  const h = request.headers.get("cookie") || "";
  const parts = h.split(/;\s*/);
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k === name) return v || "";
  }
  return null;
}

function uuidv4() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const hex = [...a].map(b => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10,16).join("")}`;
}

function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toBase64URL(a);
}

function sanitizeUsername(s) {
  const t = String(s || "").trim().slice(0, 32);
  return t || "Runner";
}

function generateUsername() {
  return "Runner-" + randomToken(6);
}

function userKey(userId) { return `user:v1:${userId}`; }
function credKey(credId) { return `cred:v1:${credId}`; }
function regChallengeKey(flowId) { return `challenge:v1:reg:${flowId}`; }
function authFlowKey(flowId) { return `challenge:v1:auth:${flowId}`; }
function sessionKey(token) { return `sess:v1:${token}`; }

async function getUser(env, userId) {
  return await getKV(env, userKey(userId));
}

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

// Base64URL helpers (Uint8Array <-> base64url string)
function toBase64URL(data) {
  let bytes = data;
  if (Array.isArray(data)) bytes = new Uint8Array(data);
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  let b64 = btoa(bin);
  return b64.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64URL(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = s + pad;
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

function utf8ToBytes(s) {
  return new TextEncoder().encode(String(s));
}

function originOk(request, url) {
  const origin = request.headers.get("origin");
  // Some tools may not send Origin; only enforce when present
  if (origin && origin !== url.origin) return false;
  return true;
}
