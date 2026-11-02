# Veloces

Veloces is a Colombian delivery network built for e-commerce and dropshipping shops. It also
operates in Mexico, Ecuador and Chile, working with allied local couriers. Tracked through the
lookup its tracker makes.

## How it works

1. `direct`: one `GET https://tracking.veloces.app/veloces/shipments/{guide}/tracking` with the
   headers `Accept: application/json` and `X-White-Label: false`, as the page at
   `tracking.veloces.app/tracking-client/{guide}` sends it. It needs no cookie, token, key or
   browser. The JSON reply is the shipment record, with its current status and its history
   oldest first.
2. `retry`: a read that fails to reach the site, or hangs, is sent once more inside the budget.

- An unknown guide is HTTP 404 with `{"error_code":404,"message":"Shipment not found"}`, which
  the page reports as not found. A 404 without that error, or a redirect, is a moved route.
- The service allows ten lookups per address every ten seconds and answers the next with HTTP
  429. Its `X-RateLimit-Reset`, read against the reply's `Date`, gives the retry time.
- The record must be the whole guide asked.

## Notes

- Each status's `created_at` is an instant in UTC, which the page shows in the visitor's own
  zone, so scans keep it as `time`.
- The status `id` stages a scan and is its provider code; an id the map does not know falls to
  its name. The summary status, which heads the page, decides the stage.
- A courier's report (`Novedad`) carries a reason from Veloces' list, such as `No hay quien
  reciba.`, which is appended to the status name. The driver's free-text remark is not kept.
- The page shows the destination-warehouse statuses once per delivery attempt; so does the
  adapter.
- The record also holds the sender, the recipient and their addresses and phone numbers, the
  driver, proof-of-delivery photos, payment and cash-on-delivery amounts. None of it is kept.
- No recognition: no detection rule claims Veloces guides.

## Limitations

- No location, estimate, service or weight.
- Operational incident notices the page shows above the history are not read.

## Numbers

Veloces guide numbers are `V` followed by ten digits; the adapter takes only that shape. The
UPS and DTDC rules already offer it, so no rule claims it for Veloces.

## Links

`tracking.veloces.app/tracking-client/{number}` opens one guide; the tracker's search form
builds that address.

## Testing

`npm run test:carriers:live -- carriers/veloces`, with `VELOCES_TRACKING_NUMBER` and optionally
`VELOCES_UNKNOWN_NUMBER` set outside the repository.
