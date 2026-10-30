import { AUTH_ROUTES } from "./auth.js";
import { HISTORY_ROUTES } from "./history.js";
import { json, randomToken, contentSecurityPolicy, withSecurityHeaders } from "./lib.js";

// pathname -> { METHOD: handler(ctx) }. Handlers receive { request, env, url, responseHeaders }
// and, behind requireSession, { session, user, userId }.
const ROUTES = { ...AUTH_ROUTES, ...HISTORY_ROUTES };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log(`Request: ${request.method} ${url.pathname}${url.search}`);

    // Route API requests first
    if (url.pathname.startsWith("/api/")) {
      let res;
      try {
        res = await handleApi(request, env, url);
      } catch (e) {
        console.error("API error", e);
        res = json({ error: "internal error" }, 500);
      }
      return withSecurityHeaders(res, { api: true });
    }
    return withSecurityHeaders(await serveStatic(request, env));
  },
};

async function serveStatic(request, env) {
  if (!env.ASSETS) return new Response("Static assets are not configured.", { status: 404 });
  const res = await env.ASSETS.fetch(request);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("text/html") ? injectWithRewriter(res, env) : res;
}

const MAPS_KEY_PLACEHOLDER = "__GOOGLE_MAPS_API_KEY__";

// Injects the Maps API key into the Maps loader URL and a per-response CSP nonce into every <script>.
function injectWithRewriter(res, env) {
  const key = env.GOOGLE_MAPS_API_KEY || "";
  const nonce = randomToken(16);
  const out = new HTMLRewriter()
    .on('link[rel="modulepreload"]', {
      element(el) { el.setAttribute("nonce", nonce); },
    })
    .on("script", {
      element(el) {
        el.setAttribute("nonce", nonce);
        const src = el.getAttribute("src") || "";
        if (src.includes(MAPS_KEY_PLACEHOLDER)) {
          el.setAttribute("src", src.replaceAll(MAPS_KEY_PLACEHOLDER, encodeURIComponent(key)));
        }
      },
    })
    .transform(res);
  const h = new Headers(out.headers);
  h.delete("content-length");
  h.delete("content-encoding");
  h.delete("etag");
  h.set("content-type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  return new Response(out.body, { status: out.status, headers: h });
}

async function handleApi(request, env, url) {
  const route = ROUTES[url.pathname];
  if (!route) return json({ error: "not found" }, 404);
  const handler = route[request.method];
  if (!handler) {
    return json({ error: "method not allowed" }, 405, { Allow: Object.keys(route).join(", ") });
  }
  const responseHeaders = new Headers();
  const res = await handler({ request, env, url, responseHeaders });
  for (const [k, v] of responseHeaders) res.headers.append(k, v);
  return res;
}
