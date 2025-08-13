function acceptsHtml(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html") || accept.includes("*/*");
}

export default {
  async fetch(request, env) {
    //console.log(`Worker started at ${new Date().toISOString()}`);
    //console.log(env);
    const url = new URL(request.url);
    console.log(`Request: ${request.method} ${url.pathname}${url.search}`);

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
