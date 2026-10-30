import { describe, it, expect } from "vitest";
import worker from "../index.js";

// No KV/D1 bindings: every session lookup fails, which is enough to check routing.
const env = {};
const call = (path, init) => worker.fetch(new Request(`https://svr.test${path}`, init), env);

describe("API routing", () => {
  it("returns 404 for unknown API paths", async () => {
    expect((await call("/api/nope")).status).toBe(404);
  });

  it("returns 405 with an Allow header built from the route table", async () => {
    const res = await call("/api/history", { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  it("rejects protected routes without a session", async () => {
    expect((await call("/api/status")).status).toBe(401);
    expect((await call("/api/history?day=2026-10-30")).status).toBe(401);
    expect((await call("/api/auth/session")).status).toBe(401);
  });

  it("rejects cross-origin auth requests", async () => {
    const res = await call("/api/auth/login/options", {
      method: "POST",
      headers: { origin: "https://evil.test" },
    });
    expect(res.status).toBe(400);
  });
});
