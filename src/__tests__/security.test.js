import { describe, it, expect, beforeEach } from "vitest";
import worker from "../index.js";
import { contentSecurityPolicy } from "../lib.js";

const ORIGIN = "https://svr.test";
const DAY_MS = 24 * 60 * 60 * 1000;

// Minimal in-memory stand-in for a KV namespace (JSON values only).
function fakeKV() {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value, options = {}) { store.set(key, value); puts.push({ key, options }); },
    async delete(key) { store.delete(key); },
  };
}

let env;
const call = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
const withSession = (headers = {}) => ({ cookie: "svr_session=tok", ...headers });

function seedUser({ credentials = ["cred-a", "cred-b"], session = {} } = {}) {
  env.SVR_KV.store.set("user:v1:u1", JSON.stringify({
    userId: "u1",
    username: "Runner",
    credentials: credentials.map((id) => ({ id, publicKey: "x", counter: 0 })),
  }));
  env.SVR_KV.store.set("sess:v1:tok", JSON.stringify({
    userId: "u1",
    credentialId: "cred-a",
    createdAt: Date.now(),
    renewedAt: Date.now(),
    ...session,
  }));
}

beforeEach(() => {
  env = { SVR_KV: fakeKV() };
});

describe("session validation", () => {
  it("accepts a session whose passkey is still registered", async () => {
    seedUser();
    const res = await call("/api/auth/session", { headers: withSession() });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("revokes a session once its passkey is removed", async () => {
    seedUser({ credentials: ["cred-b"] });
    const res = await call("/api/auth/session", { headers: withSession() });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/svr_session=;.*Max-Age=0/);
    expect(env.SVR_KV.store.has("sess:v1:tok")).toBe(false);
  });

  it("revokes a session whose user no longer exists", async () => {
    seedUser();
    env.SVR_KV.store.delete("user:v1:u1");
    expect((await call("/api/auth/session", { headers: withSession() })).status).toBe(401);
  });

  it("renews an old session with a TTL and a fresh cookie", async () => {
    const old = Date.now() - 60 * DAY_MS;
    seedUser({ session: { createdAt: old, renewedAt: undefined } });
    const res = await call("/api/auth/session", { headers: withSession() });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/svr_session=tok;.*Max-Age=31536000/);
    const put = env.SVR_KV.puts.find((p) => p.key === "sess:v1:tok");
    expect(put.options.expirationTtl).toBe(31536000);
    expect(JSON.parse(env.SVR_KV.store.get("sess:v1:tok")).renewedAt).toBeGreaterThan(old);
  });
});

describe("POST origin and content-type checks", () => {
  const point = JSON.stringify({ point: { lat: 35.68, lng: 139.76 } });

  it("rejects a POST without an Origin header", async () => {
    seedUser();
    const res = await call("/api/history", {
      method: "POST",
      headers: withSession({ "content-type": "application/json" }),
      body: point,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a text/plain body (form-style CSRF) with 415", async () => {
    seedUser();
    const res = await call("/api/history", {
      method: "POST",
      headers: withSession({ origin: ORIGIN, "content-type": "text/plain" }),
      body: point,
    });
    expect(res.status).toBe(415);
  });

  it("accepts a same-origin JSON POST", async () => {
    seedUser();
    const res = await call("/api/history", {
      method: "POST",
      headers: withSession({ origin: ORIGIN, "content-type": "application/json" }),
      body: point,
    });
    expect(res.status).toBe(200);
  });
});

describe("rate limiting", () => {
  const denying = { limit: async () => ({ success: false }) };

  it("returns 429 for unauthenticated auth steps over the limit", async () => {
    env.AUTH_LIMITER = denying;
    const res = await call("/api/auth/login/options", { method: "POST", headers: { origin: ORIGIN } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("keys signed-in writes by user and returns 429 over the limit", async () => {
    seedUser();
    const keys = [];
    env.WRITE_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    const res = await call("/api/auth/username", {
      method: "POST",
      headers: withSession({ origin: ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ username: "New" }),
    });
    expect(res.status).toBe(429);
    expect(keys).toEqual(["u1"]);
  });
});

describe("security headers", () => {
  it("adds hardening headers and no-store to API responses", async () => {
    const res = await call("/api/auth/session");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("builds a nonce-based CSP that forbids framing", () => {
    const csp = contentSecurityPolicy("abc");
    expect(csp).toContain("script-src 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
