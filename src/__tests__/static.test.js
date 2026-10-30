import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

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

describe("web app manifest", () => {
  const html = readFileSync(new URL("index.html", PUBLIC), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", PUBLIC), "utf8"));

  it("is linked from index.html with the icons it needs to be installable", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(manifest.name && manifest.start_url && manifest.display).toBeTruthy();
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("only points at icon files that exist", () => {
    const paths = [...manifest.icons.map((i) => i.src), "/icons/apple-touch-icon.png", "/icons/icon.svg"];
    for (const p of paths) expect(existsSync(new URL(p.slice(1), PUBLIC)), p).toBe(true);
  });
});
