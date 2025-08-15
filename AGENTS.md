# Repository Guidelines

## Project Structure & Modules
- `spec.md` : Specification of this web application.
- `src/`: Cloudflare Worker code. Entry is `src/index.js` exporting `fetch`.
- `public/`: Static assets served via Wrangler assets (`index.html`, `app.js`).
- `wrangler.toml`: Worker, assets, and KV configuration.
- `.dev.vars`: Local env vars for `wrangler dev` (git-ignored).
- `.wrangler/`: Local simulator state (git-ignored).

## Build, Test, and Development
- `npm run dev`: Start local dev server on `http://127.0.0.1:8787`.
- `npm run preview`: Remote dev using Cloudflare’s edge.
- `npm run deploy`: Deploy the Worker using Wrangler.
- Secrets: `wrangler secret put GOOGLE_MAPS_API_KEY` (prod). For local, add to `.dev.vars` as `GOOGLE_MAPS_API_KEY=...`.
- KV: Update `[[kv_namespaces]]` IDs in `wrangler.toml` for real environments.

## Coding Style & Naming
- JavaScript (ES Modules, `"type":"module"`). Use 2-space indent, double quotes, and semicolons.
- Filenames: lower-case with dashes or simple names (e.g., `index.js`, `app.js`).
- Functions/vars: `camelCase`; constants: `UPPER_SNAKE_CASE`.
- Routes live in `fetch` within `src/index.js` (e.g., `/api/status`, `/api/history`). Keep handlers small and pure where possible.

## Testing Guidelines
- No test harness is configured yet. If adding tests, prefer `vitest` and place files as `src/**/*.test.js` or `src/__tests__/*`. Keep API handlers factored for unit testing.
- Manual checks: run `npm run dev` and exercise endpoints: `GET /api/status?userId=...`, `GET/POST /api/history`.

## Commit & Pull Requests
- Commits: concise, imperative, scope in parentheses when helpful.
  - Example: `feat(worker): validate score input` or `fix(kv): trim leaderboard to 100`.
- PRs must include: purpose, summary of changes, manual test notes, screenshots (UI), and linked issues.
- Keep PRs focused and small; update docs when changing routes, env, or KV schema.

## Security & Configuration
- API key injection: HTMLRewriter replaces `__GOOGLE_MAPS_API_KEY__` in `public/index.html` at runtime.
- Do not commit secrets. Use Wrangler secrets for production and `.dev.vars` for local only.
- Validate and sanitize user input server-side in API handlers (`/api/status`, `/api/history`).
