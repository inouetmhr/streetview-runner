function acceptsHtml(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html") || accept.includes("*/*");
}

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
    <p>Try the leaderboard at <code>/api/leaderboard</code>.</p>
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

function withContentType(headers, value) {
  const h = new Headers(headers);
  h.set("content-type", value);
  return h;
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

const LEADERBOARD_KEY = "leaderboard:v1";
const MAX_ENTRIES = 100; // keep top 100

async function getLeaderboard(env, limit = 25) {
  if (!env.KV) return [];
  const raw = await env.KV.get(LEADERBOARD_KEY, { type: "json" });
  const items = Array.isArray(raw) ? raw : [];
  return items.slice(0, limit);
}

async function submitScore(env, entry) {
  if (!env.KV) return entry;
  const now = Date.now();
  const newEntry = { name: sanitizeName(entry.name), score: Number(entry.score), ts: now };
  const raw = await env.KV.get(LEADERBOARD_KEY, { type: "json" });
  const items = Array.isArray(raw) ? raw : [];
  items.push(newEntry);
  // Sort descending by score, then ascending by timestamp (earlier first)
  items.sort((a, b) => (b.score - a.score) || (a.ts - b.ts));
  const trimmed = items.slice(0, MAX_ENTRIES);
  await env.KV.put(LEADERBOARD_KEY, JSON.stringify(trimmed), { expirationTtl: 60 * 60 * 24 * 365 });
  return newEntry;
}

function sanitizeName(name) {
  // remove control chars and collapse whitespace
  return name.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim() || "Player";
}

// ----- Status/History API (Firestore/IndexedDB replacement) -----

async function handleApi(request, env, url) {
  const { pathname, searchParams } = url;
  if (pathname === "/api/status") {
    if (request.method === "GET") {
      const userId = (searchParams.get("userId") || "").trim();
      if (!userId) return json({ error: "userId required" }, 400);
      const key = statusKey(userId);
      const stored = env.KV ? await env.KV.get(key, { type: "json" }) : null;
      const fallback = defaultLocation();
      return json({ ok: true, status: stored || fallback });
    }
    if (request.method === "POST") {
      const body = await safeJson(request);
      if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
      const { userId, location } = body;
      if (!userId || !location || !isFinite(location.lat) || !isFinite(location.lng)) {
        return json({ error: "userId and numeric lat,lng required" }, 400);
      }
      const status = {
        lat: Number(location.lat),
        lng: Number(location.lng),
        heading: isFinite(location.heading) ? Number(location.heading) : 0,
        ts: Date.now(),
      };
      if (env.KV) {
        await env.KV.put(statusKey(userId), JSON.stringify(status));
      }
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405, { Allow: "GET, POST" });
  }

  if (pathname === "/api/history") {
    if (request.method === "GET") {
      const userId = (searchParams.get("userId") || "").trim();
      const day = (searchParams.get("day") || today()).trim();
      if (!userId) return json({ error: "userId required" }, 400);
      const key = historyKey(userId, day);
      const items = env.KV ? await env.KV.get(key, { type: "json" }) : null;
      return json({ ok: true, items: Array.isArray(items) ? items : [] });
    }
    if (request.method === "POST") {
      const body = await safeJson(request);
      if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
      const { userId, point } = body;
      if (!userId || !point || !isFinite(point.lat) || !isFinite(point.lng)) {
        return json({ error: "userId and numeric lat,lng required" }, 400);
      }
      const day = point.day || today();
      const item = {
        lat: Number(point.lat),
        lng: Number(point.lng),
        heading: isFinite(point.heading) ? Number(point.heading) : 0,
        ts: isFinite(point.ts) ? Number(point.ts) : Date.now(),
      };
      let arr = [];
      if (env.KV) {
        const key = historyKey(userId, day);
        const stored = await env.KV.get(key, { type: "json" });
        arr = Array.isArray(stored) ? stored : [];
        arr.push(item);
        // Keep array from growing unbounded; trim to last N
        const MAX_POINTS = 500;
        if (arr.length > MAX_POINTS) arr = arr.slice(arr.length - MAX_POINTS);
        await env.KV.put(key, JSON.stringify(arr));
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
function defaultLocation() { return { lat: 37.769263, lng: -122.450727, heading: 165, ts: Date.now() }; }
