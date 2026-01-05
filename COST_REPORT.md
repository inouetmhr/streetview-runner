# Cost Report (Per-User / Monthly)

(as of 2026-01-05)

This report summarizes the per-user and total monthly cost estimate for this
web app based on the user's provided usage assumptions and current Cloudflare
and Google Maps pricing. Prices are USD and were taken from official docs
referenced below.

## Assumptions

- Period: monthly.
- Active users: 100.
- Usage per user: 10 days/month, 20 km/day.
- Street View update interval: 10 m.
- Worker API requests: 2,000 per user/month.
- D1 reads: 30 per user/month.
- D1 writes: 2,000 per user/month (100 m write interval).
- Auth: once per use day (10 logins per user/month).
- Maps JS load: 1 per day (10 per user/month).
- Street View updates use "Dynamic Street View" SKU.
- Maps JS loads use "Dynamic Maps" SKU.
- D1 row reads/writes are treated as 1 row per request for this estimate.

## Derived Usage

Per user/month:
- Distance: 200 km = 200,000 m.
- Street View updates: 200,000 / 10 = 20,000.
- Maps JS loads: 10.
- Worker requests: 2,000.
- D1 reads: 30.
- D1 writes: 2,000.
- KV reads: 2,030.
  - 2,000 from session reads (1 per API request).
  - 30 from login flow (3 reads per login x 10).
- KV writes: 30 (3 writes per login x 10).
- KV deletes: 10 (1 delete per login x 10).

100 users/month:
- Street View updates: 2,000,000.
- Maps JS loads: 1,000.
- Worker requests: 200,000.
- D1 reads: 3,000.
- D1 writes: 200,000.
- KV reads: 203,000.
- KV writes: 3,000.
- KV deletes: 1,000.

## Pricing References

Cloudflare Workers + KV + D1:
- https://developers.cloudflare.com/workers/platform/pricing/

Google Maps Platform pricing:
- https://developers.google.com/maps/billing-and-pricing/pricing

## Pricing Notes Used

Cloudflare Workers (Standard plan):
- Includes 10M requests/month. $0.30 per additional 1M.
- $5/month base subscription.

Workers KV (Paid plan):
- Reads: 10M/month included, +$0.50 per 1M over.
- Writes: 1M/month included, +$5.00 per 1M over.
- Deletes: 1M/month included, +$5.00 per 1M over.

D1 (Paid plan):
- Rows read: 25B/month included, +$0.001 per 1M over.
- Rows written: 50M/month included, +$1.00 per 1M over.

Google Maps (Maps - loads):
- Dynamic Maps: Free Usage Cap 10,000.
- Dynamic Street View: Free Usage Cap 5,000.
  - Cap 100,000: $14.00 / 1,000
  - 100,001 - 500,000: $11.20 / 1,000
  - 500,001 - 1,000,000: $8.40 / 1,000
  - 1,000,001 - 5,000,000: $4.20 / 1,000

## Cost Calculation (100 users / month)

Cloudflare:
- Worker requests (200,000) within 10M included -> $0.
- KV reads/writes/deletes within included -> $0.
- D1 reads/writes within included -> $0.
- Workers base subscription -> $5.

Google Maps:
- Dynamic Maps: 1,000 loads within free cap -> $0.
- Dynamic Street View: 2,000,000 loads (minus 5,000 free cap)
  - 95,000 x $14/1,000 = $1,330
  - 400,000 x $11.20/1,000 = $4,480
  - 500,000 x $8.40/1,000 = $4,200
  - 1,000,000 x $4.20/1,000 = $4,200
  - Total = $14,210

Total:
- $14,215 / month for 100 users.
- $142.15 / user / month.

## Distance-Based Pricing (Dynamic Street View)

Assuming 10 m updates (100 calls per km):
- Free Usage Cap: 5,000 calls = 50 km per month (project-wide).
- After free cap, per-km pricing by volume tier:
  - Up to 1,000 km equivalent: $1.40 / km ($14.00 per 1,000).
  - 1,000 - 5,000 km equivalent: $1.12 / km ($11.20 per 1,000).
  - 5,000 - 10,000 km equivalent: $0.84 / km ($8.40 per 1,000).
  - 10,000 - 50,000 km equivalent: $0.42 / km ($4.20 per 1,000).

## Open Points

- If Street View updates should be billed differently (e.g., different SKU),
  update the calculation accordingly.
- D1 row reads/writes may exceed 1 per request depending on query shapes.
  This estimate assumes 1 row read/write per request for simplicity.
