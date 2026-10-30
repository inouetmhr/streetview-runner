import { describe, it, expect } from "vitest";
import worker from "../index.js";

// Minimal D1 stand-in: records statements and answers batch()/all() from canned rows.
function fakeD1(rowsFor) {
  const calls = { batch: 0, all: 0 };
  const stmt = (sql) => ({
    sql,
    bind(...args) { this.args = args; return this; },
    async all() { calls.all++; return { results: rowsFor(this.sql) }; },
  });
  return {
    calls,
    prepare: stmt,
    async batch(stmts) { calls.batch++; return stmts.map((s) => ({ results: rowsFor(s.sql) })); },
  };
}

function kvWithSession() {
  const store = new Map([
    ["sess:v1:tok", { userId: "u1", credentialId: "c1", createdAt: Date.now(), renewedAt: Date.now() }],
    ["user:v1:u1", { userId: "u1", username: "R", credentials: [{ id: "c1" }] }],
  ]);
  return { async get(k) { return store.get(k) ?? null; }, async put() {}, async delete() {} };
}

describe("GET /api/status", () => {
  it("reads the latest point and the day's points in a single D1 batch", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const latest = { lat: 35.002, lng: 139, heading: 90, ts: 3 };
    const db = fakeD1((sql) => (sql.includes("LIMIT 1")
      ? [latest]
      : [{ lat: 35, lng: 139, ts: 1 }, { lat: 35.001, lng: 139, ts: 2 }]));
    const env = { SVR_KV: kvWithSession(), SVR_DB: db };
    const res = await worker.fetch(new Request(`https://svr.test/api/status?day=${day}`, { headers: { cookie: "svr_session=tok" } }), env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toEqual(latest);
    expect(body.dailyDistanceMeters).toBeGreaterThan(100);
    expect(db.calls).toEqual({ batch: 1, all: 0 });
  });
});
