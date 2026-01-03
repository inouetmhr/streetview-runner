# Street View Runner

A web app that turns a Bluetooth fitness bike into a Street View "indoor ride" experience.

## Features
- Fitness bike integration via Web Bluetooth
- Google Street View panorama with auto-advance by bike sensors
- Passkey-only authentication
- Ride history

## Requirements
- Cloudflare account with Workers, KV, and D1 enabled
- Node.js 18+
- Fitness bike that supports BLE features (FTMS/Indoor Bike Data)
- Web browsers that support Web Bluetooth and passkeys (Chrome/Edge, excluding iOS versions)

## Project Structure
- `public/` Static assets (`index.html`, `app.js`)
- `src/` Cloudflare Worker (`src/index.js`)
- `SPEC.md` Full specification and API behavior
- `DEPLOY.md` Detailed deployment steps
- `wrangler.toml` Wrangler configuration example

## Local Setup
1) Install dependencies:

```bash
npm install
```

2) Add your Maps API key to `.dev.vars` (git-ignored):

```bash
GOOGLE_MAPS_API_KEY=YOUR_KEY
```

3) Authenticate Wrangler:

```bash
npx wrangler login
```

4) Create KV and D1, then set IDs in `wrangler.toml`:

```bash
npx wrangler kv namespace create SVR_KV
npx wrangler d1 create svr-db
```

## Development
- Local dev: `npm run dev` (http://127.0.0.1:8787)
- Edge preview: `npm run preview`

## Production Deploy (local-only config)
Keep `wrangler.toml` in Git and store production routes/IDs in a local-only config:

1) Copy the shared config:

```bash
cp wrangler.toml wrangler.production.toml
```

2) Edit `wrangler.production.toml` and add production values:
- `routes` (example in `wrangler.toml` comment)
- KV namespace `id`
- D1 `database_id`

3) Deploy using the production config:

```bash
npx wrangler deploy --config wrangler.production.toml
```

## Secrets
- Production: `npx wrangler secret put GOOGLE_MAPS_API_KEY`
- Local: `.dev.vars` only

## Others
See [SPEC.md](SPEC.md) for details.
