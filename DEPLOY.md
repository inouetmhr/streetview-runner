Deploying to Cloudflare Workers

Prereqs
- Node 18+ and `npm` installed.
- Cloudflare account with Workers + KV enabled.
- Wrangler CLI: uses `devDependency` (npx will run it).

Local Development
- Add your Google Maps key to `.dev.vars` (git-ignored):
  - `GOOGLE_MAPS_API_KEY=YOUR_KEY`
- Start local dev: `npm run dev` → http://127.0.0.1:8787

Authenticate
- `npx wrangler login`

Create KV Namespace
- `npx wrangler kv namespace create SVR_KV`
- Copy the returned `id` (and `preview_id` if shown) into `wrangler.toml` under the root `[[kv_namespaces]]` section.

Set Secret (do not commit keys)
- `npx wrangler secret put GOOGLE_MAPS_API_KEY`

Preview at the Edge
- `npm run preview`

Deploy
- `npm run deploy`

Verify
- Open the Worker URL (e.g., `https://svr-cf.<subdomain>.workers.dev`).
- Confirm Google Maps loads and Street View renders.
- Web Bluetooth works only on HTTPS in supported browsers (e.g., Chrome).
- Exercise auth flows (Register/Login) and check `/api/status` and `/api/history` persist via KV.

Notes
- Secrets are not in `wrangler.toml`. Local dev reads `.dev.vars`; deployed Workers use secrets set via `wrangler secret`.
- Static files are served from `/public` via the `ASSETS` binding; the Worker injects the Maps API key into HTML at runtime.
