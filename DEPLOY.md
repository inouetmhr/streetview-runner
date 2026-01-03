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
- Copy the returned `id` (and `preview_id` if shown) into your local config:
  - Local/dev: `wrangler.toml`
  - Production: copy `wrangler.toml` → `wrangler.production.toml` (local-only; git-ignored), then replace values

Create D1 Database
- `npx wrangler d1 create svr-db`
- Copy the returned `database_id` into your local config:
  - Local/dev: `wrangler.toml`
  - Production: `wrangler.production.toml` (local-only; git-ignored)

Set Secret (do not commit keys)
- `npx wrangler secret put GOOGLE_MAPS_API_KEY`

Preview at the Edge
- `npm run preview`

Deploy
- `npm run deploy`
- Production (local-only config): `npx wrangler deploy --config wrangler.production.toml`
  - Start from `wrangler.toml` and copy to `wrangler.production.toml`, then add `routes` and real IDs.
  - Example:
    - `routes = [{ pattern = "your-domain.example/*", zone_name = "example" }]`

Verify
- Open the Worker URL (e.g., `https://svr-cf.<subdomain>.workers.dev`).
- Confirm Google Maps loads and Street View renders.
- Web Bluetooth works only on HTTPS in supported browsers (e.g., Chrome).
- Exercise auth flows (Register/Login) and check `/api/status` and `/api/history` persist via KV.

Notes
- Secrets are not in `wrangler.toml`. Local dev reads `.dev.vars`; deployed Workers use secrets set via `wrangler secret`.
- Static files are served from `/public` via the `ASSETS` binding; the Worker injects the Maps API key into HTML at runtime.
- Keep `wrangler.toml` in Git for shared defaults; store production routes and IDs in `wrangler.production.toml` (git-ignored).
