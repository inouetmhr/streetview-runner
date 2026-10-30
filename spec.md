# Street View Runner Web App Spec
## Overview
- Build a Street View “indoor ride” where an FTMS bike drives movement. Web Bluetooth reads Indoor Bike Data and the app advances panoramas by true distance traveled.
- Cloudflare Worker derives last location from D1 history and stores per‑day history in D1.

## Goals
- FTMS‑only BLE (service `0x1826`), subscribe to Indoor Bike Data (`0x2AD2`).
- Movement driven by total distance deltas from BLE device.
- Persist path history and derive last pano `{lat,lng,heading,ts}` from history.
- Passkey-only simple authentication.

## Non‑Goals
- Interaction between users.

## Environment
- Repo: root of this project; frontend in `public/`, Worker in `src/`.
- Runtime: Browser (Web Bluetooth secure context) + Cloudflare Workers (KV bound as `SVR_KV`, D1 bound as `SVR_DB`, assets bound as `ASSETS`).
- Approvals/Sandbox: approvals on‑request; filesystem workspace‑write; network restricted.
- Commands: `npm run dev`, `npm run preview`, `npm run deploy`.
- Secrets: `GOOGLE_MAPS_API_KEY` via Wrangler secret; for local `.dev.vars` only.

## Interfaces

### Routes (Worker)
- GET `/api/status?day=YYYY-MM-DD`
  - 200 `{ ok: true, status: { lat:number, lng:number, heading:number, ts:number }, dailyDistanceMeters:number, day:string }`
  - With D1 enabled, status is derived from the latest history point (any day). `dailyDistanceMeters` sums the given ride day (defaults to the server's UTC day).
- GET `/api/history?day=YYYY-MM-DD`
  - 200 `{ ok: true, items: Array<{ lat,lng,heading,ts }>, summary:{ distanceMeters:number, movingSeconds:number, count:number } }`; day defaults to today.
- GET `/api/history?from=YYYY-MM-DD&to=YYYY-MM-DD`
  - 200 `{ ok: true, items: Array<{ day,lat,lng,heading,ts }>, summary:{ distanceMeters:number, movingSeconds:number, count:number, days: Array<{ day, distanceMeters, movingSeconds, count }> } }`
  - Distance and time are summed per day; a segment never joins the last point of one day to the next. `movingSeconds` counts gaps of up to 5 minutes between saved points (longer gaps are breaks).
  - The range is inclusive and limited to 31 days; wider ranges return 400.
- POST `/api/history`
  - Body `{ point:{ lat:number, lng:number, heading?:number, ts?:number, day?:string } }`
  - 200 `{ ok: true }`; 400 on invalid input: lat outside −90..90, lng outside −180..180, `ts` more than 24 h from server time, or `day` not a valid date within ±1 day of the server's UTC day.
- Errors: 405 Method Not Allowed with `Allow` header for wrong method; 500 returns `{ error: "internal error" }` without details.

### Ride Day
- A ride day is the user's **local** calendar day with the rollover at **03:00** local time (a ride at 02:30 counts toward the previous day).
- The client computes it (`rideDay()` in `public/geo.js`) and sends it as `point.day` and `GET /api/status?day=`.
- History rows written before this change use UTC days; they are not migrated.

### Authentication (Passkey)
- Library: `@simplewebauthn/server@^14` (server) and `@simplewebauthn/browser@14` (client, self-hosted in `public/vendor/`).
- Endpoints:
  - GET `/api/auth/session` → `{ ok:true, user:{ userId, username } }` or 401 when no valid session.
  - POST `/api/auth/register/options` → returns `{ ok:true, options, flowId }`. Server generates `userId` and uses byte `userID` for WebAuthn.
  - POST `/api/auth/register/verify` → body `{ flowId, response }`; verifies attestation; creates user + credential; sets `svr_session` cookie; returns `{ ok:true, user:{ userId, username } }`.
  - POST `/api/auth/passkeys/options` → returns `{ ok:true, options, flowId }`. Requires session; creates registration options to add a credential.
  - POST `/api/auth/passkeys/verify` → body `{ flowId, response }`; verifies attestation; adds credential to existing user; returns `{ ok:true, user:{ userId, username } }`.
  - GET `/api/auth/passkeys` → returns `{ ok:true, items:[{ id, transports?, label? }], currentCredentialId }`. Requires session; `currentCredentialId` comes from the current session.
  - POST `/api/auth/passkeys/delete` → body `{ credentialId }`; removes a credential; returns `{ ok:true, items:[...], currentCredentialId }`. Rejects when attempting to delete the last passkey.
  - POST `/api/auth/passkeys/label` → body `{ credentialId, label }`; updates a credential label; returns `{ ok:true, items:[...], currentCredentialId }`.
  - POST `/api/auth/login/options` → returns `{ ok:true, options, flowId }` (resident/discoverable; empty `allowCredentials`).
  - POST `/api/auth/login/verify` → body `{ flowId, response }`; verifies assertion; updates counter; sets `svr_session` cookie; returns `{ ok:true, user:{ userId, username } }`.
  - POST `/api/auth/username` → body `{ username:string }`; updates display name; returns `{ ok:true, user:{ userId, username } }`.
  - POST `/api/auth/logout` → deletes session and clears cookie; `{ ok:true }`.

Notes:
- Registration requires resident keys: `authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }`, `attestationType: 'none'`. WebAuthn `userID` must be a ≤64‑byte BufferSource (not a string).
- Authentication requires `userVerification: 'preferred'` and discoverable credentials (no `allowCredentials`).
- Origin header must equal `expectedOrigin` on all auth endpoints (both options and verify).

### BLE (FTMS)
- Service: Fitness Machine Service `0x1826`.
- Characteristic: Indoor Bike Data `0x2AD2` (notifications enabled).
- Movement source of truth: total_distance delta between consecutive notifications. Handle counter reset/wrap by treating negative deltas as zero.
- Don't modify _parseIndoorBikeData() function.

### UI
- The main content is Street View Panorama by Google Maps, with overlaying mini map.
- History view replaces the panorama with a full-size map showing a polyline for the selected period.
- Overlay HUD (top-center on pano)
  - Speed (km/h) and today’s distance (km) in a compact HUD bar.
  - Title text ("Street View Runner") sits above the metrics and hides when speed becomes >0.
- Controls
  - Menu icon is fixed at the top-left and toggles the side pane.
  - "Connect Sensor" button sits next to the menu icon; shown only when no BLE device is connected.
  - Tap Zone is fixed near the bottom center; tapping or Space boosts virtual speed (hidden when BLE is connected).
- Side Pane: following elements are show in a pane that is collapsible and hidden in default (slides in from the left).
  - User info: user name with an Edit button, register/login/add-passkey controls; Logout is shown on the User header.
  - History: day/week/month range selectors with previous/next controls; shows distance, riding time and average speed, plus a per-day list (distance bar and time) in week/month mode, and opens History view.
  - Display name and passkey labels are edited in place (Enter or leaving the field saves, Esc cancels). Removing a passkey and choosing a display name at registration use an in-page dialog, not browser prompts.
  - Device: Device name, active service, connection status; sensor metrics: speed (km/h), cadence (rpm), distance (m).
- Interactions: choose forward link closest to current heading;  auto‑align POV to link heading when turn >45°.
- "Turn!" toast and beep request the user to choose a direction. The toast shows one arrow button per road from the current panorama (rotated to its direction, left to right); while it is shown, ←/→ pick the nearest road on that side, ↑ the straightest and ↓ a U-turn. With no road links it tells the user to move the pegman.
- Notices: short messages at the top of the screen for sign-in results and failures (cancelled passkey prompt, rate limit, network), passkey changes and sensor reconnects.
- Screen wake lock: the screen is kept on while a sensor or Auto forward is driving the ride (re-acquired when the page becomes visible again).
- Sensor reconnect: after an unexpected BLE disconnect, the same device is retried after 1, 2, 4, 8 and 16 s before reporting "Disconnected".
- Auth prompt: a small toast is shown near the top center when logged out, prompting Register or Login; hides on successful auth.

## Data Model / Storage (KV + D1)
### User data
  - KV: no status storage (status derives from latest history when D1 enabled)
  - D1: `history` table stores per‑day points (no KV fallback)
    - Columns: `user_id`, `day`, `ts`, `lat`, `lng`, `heading`
    - Index: `(user_id, day, ts)`

### Auth Keys (KV)
- `user:v1:{userId}` → `{ userId, username, createdAt, credentials: Array<{ id, publicKey, counter, transports?, label? }> }` (labels default to device name + registration date; user editable)
- `cred:v1:{credentialId}` → `{ userId }` (lookup by credential ID)
- `challenge:v1:reg:{flowId}` → `{ challenge, userId, username, createdAt }` (ephemeral; TTL ~10m)
- `challenge:v1:auth:{flowId}` → `{ challenge, createdAt }` (ephemeral; TTL ~10m)
- `sess:v1:{token}` → `{ userId, credentialId, createdAt, renewedAt }` (1y TTL, renewed at most every 30 days)

## Behavior
- On auth (startup)
  - Try auto login (never expire)
  - If failed, show a toast that requests user to register or login using a passkey.
    - for registraion, readable username (like Blue Dragon) is auto generate by client side. user can change it on the toast. 
    - for login, user can login with existing pasykey.
    - user do not enter user-id nor password. user id is auto generated and hidden to the user.
- Protection:
  - User related APIs (`/api/status`, `/api/history`) require a valid session; server derives `userId` from `svr_session` and ignores client‑provided `userId` on write/read.
  - Multiple credentials per user allowed; counters updated on each auth.
  - Logout clears session and requires re‑auth.
- On login
  - load daily distance for the user.
  - load today's history and put marker on mini map.
  - refresh the pano position and heading from `/api/status` if present.
- On BLE `characteristicvaluechanged` event, parsing each event, and when total_distance delta from previous one > 0 
  - update metrics and UI
  - advance (in pano), that will trigger `links_changed` event followed by `position_changed` event.
    - If required turn angle >80°: 
       - Don't advance and notify the user to choose direction.
       - if Audio: beep. throttle beeps to ≥250 ms apart.
    - measure
- On Maps `links_changed` event
  - further advance if there still are distance to go
- On Maps `position_changed` event
  - save last position to localStorage on every event.
  - persist history to cloud every ≥100 m (status derives from history; no separate status save).
  - extend the mini map trail polyline (no per-step markers, so map objects stay bounded).
  - update daily distance in localStorage from every delta.
  - do not persist the initial position immediately after login.

## Local Storage
- `dailyDistance:{userId}:{YYYY-MM-DD}` → daily distance meters (string).
- `lastPosition:{userId}` → `{ lat, lng, heading }` JSON (last known pano position).
- Startup prefers `lastPosition` over `/api/status` when available.

## Security
- Validate `userId`, `lat`, `lng`, and numeric types server‑side.
- Do not expose secrets; inject Google Maps key via HTMLRewriter at runtime.
- Web Bluetooth requires HTTPS/localhost secure context; no cross‑origin BLE access.
- WebAuthn:
  - Validate `Origin` equals `expectedOrigin`; set `rpID` to request hostname.
  - Use `HttpOnly; Secure; SameSite=Lax` cookies for sessions; `SameSite=Strict` for one‑off registration flow cookies.
  - Challenges are single-use: deleted before verification; short TTL (≈10 minutes).
  - Require `userVerification: 'preferred'`; attestation `none`.
  - The browser library is self-hosted (`public/vendor/`, built by `npm run vendor`), not loaded from a CDN.
- Sessions:
  - KV entries expire after ≈1 year (`expirationTtl`); the expiry and cookie `Max-Age` slide forward at most once per 30 days of use, approximating “never expire”.
  - Every session records the passkey (`credentialId`) it was created with, and is valid only while that passkey is still registered: removing a passkey (or the user) signs out the devices that used it (401 + cleared cookie). Sessions without a `credentialId` are rejected the same way.
- Request checks:
  - Every POST must carry `Origin` equal to the app origin (400 otherwise) and, when it has a content type, `application/json` (415 otherwise). This covers same-site subdomains that `SameSite=Lax` does not.
  - Rate limits (Workers Rate Limiting bindings): `AUTH_LIMITER` 10/min per client IP for unauthenticated register/login steps; `WRITE_LIMITER` 30/min per user for signed-in writes. Over the limit → 429 with `Retry-After`.
- Response headers: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (Bluetooth for self only); API responses are `Cache-Control: no-store`.
- HTML gets a strict CSP with a per-response nonce injected into every `<script>` by HTMLRewriter: `script-src 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'` (Maps needs WebAssembly), `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- The Google Maps key is public by design; restrict it in Google Cloud to the app's HTTP referrers and the Maps JavaScript API.

## Performance
- Browser budget: single AudioContext, minimal allocations per notification.
- Worker: KV interactions are small JSON payloads; cap history size; avoid large responses.

## Telemetry / Logging
- Worker logs request method/path; logs API errors with message.
- Frontend may log BLE connection status changes and warnings when Maps API missing.

## Acceptance Criteria
- Connecting to an FTMS bike updates cadence (rpm), speed (km/h), and distance (m) in the UI.
- Movement advances Street View driven by total_distance deltas.
- Resource usage remains stable (no `net::ERR_INSUFFICIENT_RESOURCES`).
- Passkey auth works end‑to‑end: first‑run registration creates session; subsequent visits auto‑login via session; existing APIs reject unauthenticated access (401) and use session‑derived `userId`.

## Test Plan (Manual)
1) Prefer `npm run preview` (HTTPS) for auth flows; open the provided workers.dev URL. For BLE-only checks, `npm run dev` is sufficient.
2) Connect an FTMS bike; verify device/service labels, cadence rpm, speed km/h, distance m updating.
3) Enable auto‑advance; confirm “Turn!” alerts on sharp turns.
4) History persists in KV (refresh and resume last position and day's history).
5) History view: open History, switch day/week/month, and verify distance + polyline render on the full-size map.
5) Inspect Worker logs for API requests; verify 400/405 behaviors for invalid input/methods.
6) Auth flows:
   - First visit: `GET /api/auth/session` returns 401; start registration; passkey created; cookie set; session shows user.
   - Refresh: session auto‑login; protected APIs succeed without `userId` in client.
   - Logout: `POST /api/auth/logout`; subsequent protected API calls return 401.
   - Edit username: `POST /api/auth/username` updates display name; side pane reflects change.

## Deliverables
- Frontend: `public/index.html` and ES modules: `app.js` (entry, Street View movement and wiring), `ble.js` (FTMS client and `parseIndoorBikeData`), `api.js` (Worker API client), `geo.js` (geometry/dates, shared with the Worker), `speed-meter.js` (header speed smoothing), `virtual-rider.js` (Auto forward), `trail.js` (mini map trail), `ride-storage.js` (localStorage), `dom.js` (shared DOM helpers), `auth-ui.js`, `history-view.js`.
- Worker: `src/index.js` (entry + route table), `src/auth.js`, `src/history.js`, `src/lib.js`.
- Tests: `src/__tests__/*.test.js` (vitest, `npm test`).
- Docs: this spec at `/spec.md`.

## TODO (tobe implemented in the future)
- nothing now.

## Rollout / Backout
- nothing now.
