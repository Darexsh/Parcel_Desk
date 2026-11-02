# Relay

Relay, run by Relay Technology, delivers marketplace and retailer parcels in the UK, Vinted's
among them, through its own couriers and a network of shops where parcels are dropped off and
collected. Tracked through the lookup its tracking app makes, with the delivery postcode.

## How it works

1. `direct`: one
   `GET https://relay-production.relaytechapis.co/v0/customer-portal/shipments/{ID}?postcode={postcode}`,
   as the tracking app at `track.relaytech.co` makes it. It needs no cookie, token, key or
   browser. The JSON reply is the shipment, with its scans in `events`.

- Every lookup needs the postcode, but a parcel can be added without one. Without it the
  tracker opens nothing, so the adapter makes no request and reports `input_required`, and
  enabled universal providers answer instead. The postcode goes as typed, trimmed and in
  capitals, as the app sends it.
- An unknown ID and a missing, malformed or wrong postcode all get the same 404,
  `{"detail":"No order was found for that tracking number"}`. That answer does not show the
  parcel is missing, so it is `indeterminate` (`portal_not_found`) and enabled universal
  providers can still answer.
- FastAPI's bare `Not Found` and the gateway's plain-text 404 are a moved route. A web page in
  place of the JSON is a block, whatever its status.
- Failures drop the request and response details `fetchBounded` attaches: the address holds
  the postcode.
- The shipment must answer to the ID asked, as its tracking ID, label ID or barcode.
- There is no recognition, since every lookup needs the postcode.

## Notes

- The shipment's fields come from the tracking app's script. Each scan has a `status` code, the
  words the page shows for it in `status_display_slug` and a `timestamp` the app reads as an
  instant. A timestamp with an offset keeps it; one without stays `local_time`, with no zone
  assumed. A slug shown as one, such as `out-for-delivery`, is put into words.
- `delivery_status` stages the parcel, with the same codes as the scans. A delay has no stage of
  its own, so a delayed parcel keeps the stage of the scan before.
- Today's arrival window becomes the expected delivery while the parcel is on its way and the
  window has not passed its newest scan. Out for delivery without one, the courier's estimate
  stands in. Estimates without an offset are not read.
- A parcel sent for collection gets its shop as the pickup point. The shop a seller dropped a
  parcel off at is not one.
- The recipient's address and coordinates, the safe place with its door codes, the courier's
  notes, proof-of-delivery photos and the shipper's name are not kept.
- The sender's postcode opens a parcel too; the reply's `viewer` says which side asked.

## Limitations

- No scan locations and no weight.
- Return numbers start with `RET`. The app reads them from
  `…/customer-portal/inbound-shipments/{number}`, which needs no postcode and answers
  `{"detail":"Return not found"}` for an unknown one. No public return number shows their full
  shape, so detection does not claim them and the adapter does not read them.
- The form asks for a UK postcode, while the server-side check takes any country's.

## Numbers

Relay's tracking IDs are `RELR` and eight capital letters and digits. Colis Privé's
twelve-character rule also takes that shape, but no other carrier's numbers start with Relay's
prefix, so `relaytech-1` claims them. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/relaytech`, with `RELAYTECH_POSTCODE` and
`RELAYTECH_TRACKING_NUMBER` or `RELAYTECH_UNKNOWN_NUMBER` set outside the repository.
