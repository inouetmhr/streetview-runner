import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const PUBLIC = new URL("../../public/", import.meta.url);

describe("index.html", () => {
  const html = readFileSync(new URL("index.html", PUBLIC), "utf8");

  it("preloads every frontend module so imports load in one round trip", () => {
    const modules = readdirSync(PUBLIC).filter((f) => f.endsWith(".js"));
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="\/([^"]+)"/g)].map((m) => m[1]);
    expect(preloaded.sort()).toEqual(modules.sort());
  });

  it("loads the Maps API asynchronously without unused libraries", () => {
    expect(html).toMatch(/maps\/api\/js\?key=__GOOGLE_MAPS_API_KEY__&loading=async"/);
  });
});
