# Nationex

Tracks Nationex shipments and parcels in Canada through the service behind Nationex's own
tracker.

## How it works

The tracker at `nationex.com/reperage/{number}` is a single-page app that asks
`nationex.com/api/nationex/get-shipment/{number}` for the shipment. The page posts that request
with its session's CSRF token; the service gives the same reply to a plain GET without a cookie or
token, so the adapter sends one GET and does not follow redirects. No account, key, CAPTCHA or
browser is needed. A request that fails to reach Nationex is sent once more within the budget.

A known number gets the whole shipment as JSON: its state and state history, and each parcel with
its scans, state and expected day. An unknown number gets HTTP 200 with
`{"code":404,"message":"Sorry, no results."}`, which is the only missing shipment. Any other
error object, such as the site's own failure to reach Nationex's backend, stays inconclusive, as
do redirects and HTTP 404. A Cloudflare challenge, rate limits and other HTTP errors keep their
own failure kinds. Recognition uses the same lookup.

## Numbers

A shipment number is nine digits; a parcel number is the shipment number followed by the parcel's
two-digit position. They carry no check digit. Nine digits are shared with several carriers, so
detection offers no Nationex rule and recognition is not asked for them; Nationex tracking runs
when the caller names the carrier. Anything other than nine or eleven digits is invalid without a
request.

The service also matches delivery-notice numbers and sender references, and then answers with the
shipment they belong to. The reply counts only when its shipment number, or one of its parcel
numbers, is the number asked; any other shipment is inconclusive. A shipment number covers every
parcel in it and a parcel number only that parcel.

## Notes

- Scans carry a numeric code, the depot's town and English and French wording. Codes are mapped in
  [status.ts](status.ts); other codes go to the shared wording rules. A message to the recipient
  and a photo move nothing.
- The current stage is the state Nationex keeps for the shipment, or for the parcel asked for,
  which its tracker shows as the current step. A shipment of several parcels repeats their shared
  scans once per parcel; identical rows are kept once, and a partial delivery stays in transit
  while one parcel's delivery scan is the newest. As in the tracker, a problem or cancellation at
  the end of the state history counts before the state follows it. A failed-delivery or problem
  scan stands until the shipment is delivered, returned or held. The scans decide when the state
  is unknown.
- Clocks are wall clocks without an offset and are kept as local times.
- The expected day is the latest of the parcels in view. It is shown only between the pickup and
  the delivery, as on the tracker, and is dropped once a newer day's scan has come.
- The reply also carries the recipient's postcode, town and map position, the handheld's position
  on each scan, the signer, photo and signature ids, sender references, weights, notes and the
  tracker's help texts. None of them is read.

## Limitations

Delivery-notice numbers and sender references are not tracked. Nationex purges older shipments,
which then read as not found.

## Links

Nationex's tracker opens a number at `nationex.com/reperage/{number}`, or `/tracking/` in
English.

## Live test

Set `NATIONEX_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/nationex/adapter.live.test.ts`.
Optionally set `NATIONEX_UNKNOWN_NUMBER` to check a number Nationex does not know.
