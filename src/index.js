import { AUTH_ROUTES } from "./auth.js";
import { HISTORY_ROUTES } from "./history.js";
import { json } from "./lib.js";

// pathname -> { METHOD: handler(ctx) }. Handlers receive { request, env, url } and,
// behind requireSession, { session, userId }.
const ROUTES = { ...AUTH_ROUTES, ...HISTORY_ROUTES };

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
        return json({ error: "internal error" }, 500);
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

async function handleApi(request, env, url) {
  const route = ROUTES[url.pathname];
  if (!route) return json({ error: "not found" }, 404);
  const handler = route[request.method];
  if (!handler) {
    return json({ error: "method not allowed" }, 405, { Allow: Object.keys(route).join(", ") });
  }
  return await handler({ request, env, url });
}
