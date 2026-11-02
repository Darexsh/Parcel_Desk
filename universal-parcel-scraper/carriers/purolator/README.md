# Purolator

Tracks individual Purolator PINs through the anonymous JSON endpoint used by the official portal.
Detection offers a 12-digit PIN starting with 0 to 6 only when it passes the Luhn check.
Three letters and nine digits suggest Purolator at low confidence, because TNT Australia's
domestic consignments share the shape: TNT's own tracking API files such numbers as TNT Australia
domestic. Prefixes other services use for the same shape are left to them. Among them is Cubyn's `CUB`: Cubyn was a French fulfilment service, now closed,
whose parcels are tracked under the number of the carrier it handed them to. Postmedia Parcel
Services' `BNI`, [Sendle](../sendle/README.md)'s `QSS` and
[ROZETKA Delivery](../rozetka-delivery/README.md)'s `RMP` are others.

## How it works

One POST requests descending package scans using the widget's public client key and browser
user agent. The search result's indexes must select exactly one matching package.
Ambiguous matches remain inconclusive. Purolator answers NOT FOUND both for numbers it never
issued and for PINs whose history it no longer keeps, so that reply stays inconclusive with the
reason `portal_not_found`, which tells it from an outage. AWS WAF can require an image
challenge; that failure is reported for routing fallback.

## Notes

Scans retain the provider's newest-first order. Cross-country scan clocks without offsets
remain local wall times in the host's direct history archive. They provide no verified instant
for freshness checks or the dated timeline. Each scan uses its own event code; unrecognized
codes keep their wording without inheriting an older milestone. The driver's collection at the
shipper's site, hours before the terminal records the pickup, is already accepted. Pickup availability is
distinct from parcel delivery. Shipment-level weight is retained only for a single-piece
shipment. The estimated delivery day is kept while the parcel is on its way and dropped
once a newer day's scan arrives or the parcel is delivered, returned or waiting at a
counter. The destination country comes from the shipment. Recipient information, delivery instructions, references and proof data are excluded.

## Testing

Set `PUROLATOR_TRACKING_NUMBER` to an authorized real PIN, and optionally
`PUROLATOR_UNKNOWN_NUMBER` to a PIN the tracker does not find, and run
`npm run test:carriers:live -- carriers/purolator`.
