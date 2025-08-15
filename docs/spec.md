# Street View Runner Web App Spec

## Overview
- Build a Street View “indoor ride” where an FTMS bike drives movement. Web Bluetooth reads Indoor Bike Data and the app advances panoramas by true distance traveled. Cloudflare Worker stores last location and per‑day history in KV.

## Goals
- FTMS‑only BLE (service `0x1826`), subscribe to Indoor Bike Data (`0x2AD2`).
- Movement driven by total distance deltas; fall back to mock speed when distance absent.
- Persist last pano `{lat,lng,heading,ts}` and path history; trim history to last 500 points.
- Rate‑limit auto‑advance to prevent resource exhaustion; single reusable AudioContext.

## Non‑Goals
- No Firebase/IndexedDB or leaderboard features.
- No RSC/CSC/HR services; no multi‑user auth.

## Environment
- Repo: root of this project; frontend in `public/`, Worker in `src/`.
- Runtime: Browser (Web Bluetooth secure context) + Cloudflare Workers (KV bound as `KV`, assets bound as `ASSETS`).
- Approvals/Sandbox: approvals on‑request; filesystem workspace‑write; network restricted.
- Commands: `npm run dev`, `npm run preview`, `npm run deploy`.
- Secrets: `GOOGLE_MAPS_API_KEY` via Wrangler secret; for local `.dev.vars` only.

## Interfaces

### Routes (Worker)
- GET `/api/status?userId=…`
  - 200 `{ ok: true, status: { lat:number, lng:number, heading:number, ts:number } }`
  - 400 if `userId` missing.
- POST `/api/status`
  - Body `{ userId:string, location:{ lat:number, lng:number, heading?:number } }`
  - 200 `{ ok: true }`; 400 on invalid/missing fields.
- GET `/api/history?userId=…&day=YYYY-MM-DD`
  - 200 `{ ok: true, items: Array<{ lat,lng,heading,ts }> }`; day defaults to today.
- POST `/api/history`
  - Body `{ userId:string, point:{ lat:number, lng:number, heading?:number, ts?:number, day?:string } }`
  - 200 `{ ok: true }`; trims to last 500 items per day; 400 on invalid input.
- Errors: 405 Method Not Allowed with `Allow` header for wrong method.

### BLE (FTMS)
- Service: Fitness Machine Service `0x1826`.
- Characteristic: Indoor Bike Data `0x2AD2` (notifications enabled).
- Movement source of truth: total_distance delta between consecutive notifications. Handle counter reset/wrap by treating negative deltas as zero.
- Fallbacks: If total_distance absent, integrate mock speed slider only; do not integrate BLE speed to avoid double counting.
- Don't modify _parseIndoorBikeData() function.

### UI
- Main contents is Pano by Google Maps, with Google Maps' mini map feature enabled.
- Top of the screeen
  - it shows s speed meter (km/h) and and an dmeter (km) which shows traveled distance for the day. is visible wheather or not BLE connected.
  - BLE connect button is shown when and only no BLE device is connected. 
- Side Pane: following elements (controls and status) are show in a pane that is collapsable and visible in default.
  - Controls: Connect/Disconnect BLE; Advance; Turn ◀︎/▶︎; meters per move; auto‑advance on/off; mock speed slider; start location inputs; keyboard (Space, ◀︎/▶︎, A).
  - Status: Device name, active service, connection status; metrics: speed (km/h), cadence (rpm), distance (m).
- Interactions: choose forward link closest to current heading;  auto‑align POV to link heading when turn >45°.
- "Turn!" notify popup to suggest the user to choose direction.

## Data Model / Storage (KV)
- Keys:
  - `status:v1:{userId}` → `{ lat, lng, heading, ts }` (JSON)
  - `history:v1:{userId}:{YYYY-MM-DD}` → `Array<{ lat, lng, heading, ts }>`
- Constraints: trim history arrays to 500 items; no TTL required by default.

## Behavior
- On BLE notification parsing each event
  - update metrics and UI
  - advance (in pano) when total_distance increased
    - If required turn angle >80°: 
       - Don't advance and notify the user to choose direction.
       - if Audio: beep. reuse a single AudioContext; throttle beeps to ≥250 ms apart.
  - persist location every ≥10 m.

## Security
- Validate `userId`, `lat`, `lng`, and numeric types server‑side.
- Do not expose secrets; inject Google Maps key via HTMLRewriter at runtime.
- Web Bluetooth requires HTTPS/localhost secure context; no cross‑origin BLE access.

## Performance
- Browser budget: ≤2 pano moves/sec, single AudioContext, minimal allocations per notification.
- Worker: KV interactions are small JSON payloads; cap history size; avoid large responses.

## Telemetry / Logging
- Worker logs request method/path; logs API errors with message.
- Frontend may log BLE connection status changes and warnings when Maps API missing.

## Acceptance Criteria
- Connecting to an FTMS bike updates cadence (rpm), speed (km/h), and distance (m) in the UI.
- Movement advances Street View driven by total_distance deltas; mock speed works when no BLE distance present.
- `/api/status` and `/api/history` behave exactly as specified; inputs validated, history trimmed to 500.
- No RSC/CSC code in the codebase; BLE filters FTMS only.
- Resource usage remains stable (no `net::ERR_INSUFFICIENT_RESOURCES`).

## Test Plan (Manual)
1) `npm run dev` and open `http://127.0.0.1:8787` over a secure context.
2) Connect an FTMS bike; verify device/service labels, cadence rpm, speed km/h, distance m updating.
3) Enable auto‑advance; confirm paced moves (≤2/sec) and “Turn!” alerts on sharp turns.
4) Disconnect BLE; use mock speed slider; confirm movement and that history persists in KV (refresh and resume last position).
5) Inspect Worker logs for API requests; verify 400/405 behaviors for invalid input/methods.

## Deliverables
- Frontend: `public/app.js`, `public/index.html` (labels as needed), audio + rate limiting.
- Worker: `src/index.js` with `/api/status` and `/api/history` + HTML key injection.
- Docs: this spec at `docs/ftms-spec.md`.

## Rollout / Backout
- Feature scope limited to FTMS; can disable auto‑advance via UI.
- Backout by disabling BLE connection and using mock speed only; Worker APIs are backward‑compatible.

