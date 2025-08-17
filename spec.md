# Street View Runner Web App Spec

## Overview
- Build a Street View “indoor ride” where an FTMS bike drives movement. Web Bluetooth reads Indoor Bike Data and the app advances panoramas by true distance traveled.
- Cloudflare Worker stores last location and per‑day history in KV.

## Goals
- FTMS‑only BLE (service `0x1826`), subscribe to Indoor Bike Data (`0x2AD2`).
- Movement driven by total distance deltas from BLE device.
- Persist last pano `{lat,lng,heading,ts}` and path history.
- Passkey-only simple authentication.

## Non‑Goals
- Interaction between users.

## Environment
- Repo: root of this project; frontend in `public/`, Worker in `src/`.
- Runtime: Browser (Web Bluetooth secure context) + Cloudflare Workers (KV bound as `KV`, assets bound as `ASSETS`).
- Approvals/Sandbox: approvals on‑request; filesystem workspace‑write; network restricted.
- Commands: `npm run dev`, `npm run preview`, `npm run deploy`.
- Secrets: `GOOGLE_MAPS_API_KEY` via Wrangler secret; for local `.dev.vars` only.

## Interfaces

### Routes (Worker)
- GET `/api/status`
  - 200 `{ ok: true, status: { lat:number, lng:number, heading:number, ts:number } }`
- POST `/api/status`
  - Body `{ location:{ lat:number, lng:number, heading?:number } }`
  - 200 `{ ok: true }`; 400 on invalid/missing fields.
- GET `/api/history?day=YYYY-MM-DD`
  - 200 `{ ok: true, items: Array<{ lat,lng,heading,ts }> }`; day defaults to today.
- POST `/api/history`
  - Body `{ point:{ lat:number, lng:number, heading?:number, ts?:number, day?:string } }`
  - 200 `{ ok: true }`; trims to last 500 items per day; 400 on invalid input.
- Errors: 405 Method Not Allowed with `Allow` header for wrong method.

### Authentication (Passkey)
- Library: `@simplewebauthn/server@^13` (server) and optionally `@simplewebauthn/browser@^13` (client).
- Endpoints:
  - GET `/api/auth/session` → `{ ok:true, user:{ userId, username } }` or 401 when no valid session.
  - POST `/api/auth/register/options` → WebAuthn registration options. Server generates `userId`.
  - POST `/api/auth/register/verify` → verifies attestation; creates user + credential; sets `svr_session` cookie; `{ ok:true, user:{ userId, username } }`.
  - POST `/api/auth/login/options` → WebAuthn authentication options (resident/discoverable; empty `allowCredentials`).
  - POST `/api/auth/login/verify` → verifies assertion; updates counter; sets `svr_session` cookie; `{ ok:true, user:{ userId, username } }`.
  - POST `/api/auth/logout` → deletes session and clears cookie; `{ ok:true }`.
-
Notes:
- Registration requires resident keys: `authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }`, `attestationType: 'none'`.
- Authentication requires `userVerification: 'preferred'` and discoverable credentials (no `allowCredentials`).
- Origin header must equal `expectedOrigin` on all auth endpoints.

### BLE (FTMS)
- Service: Fitness Machine Service `0x1826`.
- Characteristic: Indoor Bike Data `0x2AD2` (notifications enabled).
- Movement source of truth: total_distance delta between consecutive notifications. Handle counter reset/wrap by treating negative deltas as zero.
- Don't modify _parseIndoorBikeData() function.

### UI
- The main content is Street View Panorama by Google Maps, with overlaying mini map.
- Top of the screen
  - It shows s speed meter (km/h) and and an odometer (km) which shows traveled distance for the day.
  - BLE connect button is shown when and only no BLE device is connected. 
- Side Pane: following elements are show in a pane that is collapsible and hidden in default.
  - User info: user name, logout button.
  - Status: Device name, active service, connection status; sensor metrics: speed (km/h), cadence (rpm), distance (m).
- Interactions: choose forward link closest to current heading;  auto‑align POV to link heading when turn >45°.
- "Turn!" notify toast and beep to request the user to choose direction.

## Data Model / Storage (KV)
- Keys:
  - `status:v1:{userId}` → `{ lat, lng, heading, ts }` (JSON)
  - `history:v1:{userId}:{YYYY-MM-DD}` → `Array<{ lat, lng, heading, ts }>`
- Constraints: trim history arrays to 500 items; no TTL required by default.

### Auth Keys (KV)
- `user:v1:{userId}` → `{ userId, username, createdAt, credentials: Array<{ id, publicKey, counter, transports? }> }`
- `cred:v1:{credentialId}` → `userId` (lookup by credential ID)
- `challenge:v1:reg:{flowId}` → `{ challenge, userId, username, createdAt }` (ephemeral; TTL ~10m)
- `challenge:v1:auth:{challenge}` → `createdAt` (ephemeral; TTL ~10m)
- `sess:v1:{token}` → `{ userId, createdAt }` (long‑lived; no TTL or 1y)

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
  - persist location every ≥10 m.

## Security
- Validate `userId`, `lat`, `lng`, and numeric types server‑side.
- Do not expose secrets; inject Google Maps key via HTMLRewriter at runtime.
- Web Bluetooth requires HTTPS/localhost secure context; no cross‑origin BLE access.
- WebAuthn:
  - Validate `Origin` equals `expectedOrigin`; set `rpID` to request hostname.
  - Use `HttpOnly; Secure; SameSite=Lax` cookies for sessions; `SameSite=Strict` for one‑off registration flow cookies.
  - Delete challenges after verification; set short TTL (≈10 minutes).
  - Require `userVerification: 'preferred'`; attestation `none`.
  - Session lifetime ≈1 year (to approximate “never expire”); refresh on login.

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
1) `npm run dev` and open `http://127.0.0.1:8787` over a secure context.
2) Connect an FTMS bike; verify device/service labels, cadence rpm, speed km/h, distance m updating.
3) Enable auto‑advance; confirm “Turn!” alerts on sharp turns.
4) History persists in KV (refresh and resume last position and day's history).
5) Inspect Worker logs for API requests; verify 400/405 behaviors for invalid input/methods.
6) Auth flows:
   - First visit: `GET /api/auth/session` returns 401; start registration; passkey created; cookie set; session shows user.
   - Refresh: session auto‑login; protected APIs succeed without `userId` in client.
   - Logout: `POST /api/auth/logout`; subsequent protected API calls return 401.

## Deliverables
- Frontend: `public/app.js`, `public/index.html` (labels as needed), audio + rate limiting.
- Worker: `src/index.js` with `/api/status` and `/api/history` + HTML key injection.
- Docs: this spec at `/spec.md`.

## Rollout / Backout
- nothing now.
