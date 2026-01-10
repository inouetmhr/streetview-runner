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
- Street View loads: 2 per active day (Pano initial load only).
- Worker API requests: 2,000 per user/month.
- D1 reads: 30 per user/month.
- D1 writes: 2,000 per user/month (100 m write interval).
- Auth: once per use day (10 logins per user/month).
- Maps JS load: 1 per day (10 per user/month).
- Street View loads use "Dynamic Street View" SKU.
- Maps JS loads use "Dynamic Maps" SKU.
- D1 row reads/writes are treated as 1 row per request for this estimate.

## Derived Usage

Per user/month:
- Distance: 200 km = 200,000 m.
- Street View loads: 20.
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
- Street View loads: 2,000.
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
- Dynamic Street View: 2,000 loads within free cap -> $0.

Total:
- $5 / month for 100 users.
- $0.05 / user / month.

## Distance-Based Pricing (Dynamic Street View)

Not used in this estimate. Street View charges are based on Pano initial loads
only (2 per active day), not intra-Pano movement.

## Open Points

- If Street View updates should be billed differently (e.g., different SKU),
  update the calculation accordingly.
- D1 row reads/writes may exceed 1 per request depending on query shapes.
  This estimate assumes 1 row read/write per request for simplicity.
