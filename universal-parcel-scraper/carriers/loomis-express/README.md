# Loomis Express

Tracks Loomis Express waybills in Canada through the tracking results page on Loomis Express's
own website.

## How it works

The tracking form on `loomisexpress.com/loomship/Track` posts the waybill with an anti-forgery
token and is redirected to `/loomship/Track/TrackResults?t=WAYBILL&s=<waybill>`. The adapter reads
that page with one GET and does not follow its redirects. It is rendered on the server and needs
no account, cookie, token, CAPTCHA or browser. The page's language follows `Accept-Language`, so
the adapter asks for English. A request that fails to reach Loomis Express is sent once more
within the budget.

A known waybill is listed under "Found below waybills:", followed by a block with its scans, newest
first. Each scan has a date, a clock and a city. An unknown waybill is listed under "Below waybills
are not available at this moment:", which is the only missing parcel. A redirect and HTTP 404
stay inconclusive, as do a waybill listed without scans and a page whose lists or block do not
bind to the waybill. Block pages, rate limits and other HTTP errors keep their own failure kinds.
Recognition uses the same lookup.

## Numbers

Loomis Express waybills are `NET` or `LSHP` and eight digits. Aggregator pages print both, and
`loomis-express-1` and `loomis-express-2` claim them. Anything else is invalid without a request.
A door-knocker card number starting `DNK` is not a waybill and is quarantined. The tracker has a
separate door-knocker search, which the adapter does not use.

## Notes

- The page is accepted only when the found list names the waybill, and exactly one block has it
  as its anchor, shipment number and piece number. Blocks for other waybills are ignored.
- The scans carry no code. Their wordings are mapped whole in [status.ts](status.ts); others go
  to the shared wording rules. Delivery wordings are cut short and can go on with where the parcel
  was left, so any wording starting "Your Package was Delivered" is a delivery. A failed pickup
  leaves the parcel with its shipper, so it stays registered.
- An "Estimated Delivery Date" row is listed as the newest scan while the parcel is on its way.
  It becomes the estimate, not a scan, and is dropped once the parcel is delivered or a later
  day's scan arrives. A clock at midnight exactly, as on the shipment record and the estimate, is
  a calendar day.
- Clocks are the facilities' wall clocks without an offset and are kept as local times in the
  page's order. A parcel can cross time zones, so they are not sorted.
- Reference lines, the proof-of-delivery form and the progress bar are never read.
- TransForce's `USSAddonsService` SOAP service on `webservice.loomis-express.com` answers
  `trackByBarcode` without credentials and gives scan codes. It also returns addresses, employee
  numbers and signatures, and an unknown waybill gets an empty placeholder rather than a notice,
  so the page is used. It runs the same software as Canpar's, with its own data: neither network
  knows the other's numbers, and the reply does not name the network.

## Limitations

Only waybills are supported. The tracker's searches by reference, return authorization or
door-knocker card are not used. A block whose piece number differs from its shipment number, as
a multi-piece shipment's other pieces may have, is rejected. A waybill that has no scans yet, or
whose history has been purged, reads as not found, because the page lists it under the same
notice.

## Links

The link opens the results page for the waybill. Pasted links to that page, in English or
French, and to `/loomship/Track/TrackStatus?wbs=<waybill>`, which redirects to it, are read too.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Live test

Set `LOOMIS_EXPRESS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/loomis-express/adapter.live.test.ts`.
Optionally set `LOOMIS_EXPRESS_UNKNOWN_NUMBER` to check a waybill Loomis Express does not know.
