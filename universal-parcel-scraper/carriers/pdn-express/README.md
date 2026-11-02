# PDN Express

PDN Express B.V. delivers parcels for online shops and marketplaces, such as AliExpress orders
and Amazon sellers, to addresses in the Netherlands with its own couriers. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://pdn.express/api/track` with the body
   `{"action":"search","orderNos":"{number}","locale":"en"}`, as the tracking page sends it. It
   needs no cookie, token, key or browser. The JSON reply has one entry per number, with the
   destination country and the scans, newest first.
2. `retry`: a request that fails to reach the site, or hangs, is sent once more.

- An unknown number is HTTP 200 with an entry that has no scans and the tracker's notice that
  the lookup was not successful, which the page reports as not found. An entry without scans
  and another notice is inconclusive. A 404 or a redirect is a moved route.
- The page answers `{"ok":false,"error":"upstream"}` when the service behind it fails, which
  is inconclusive. Other errors mean the request changed.
- The entry must echo the number asked. The page itself shows the first entry when none
  matches.
- Recognition makes the same request.

## Notes

- Each scan has a wall clock, its zone and the offset of that zone at the time, such as
  `Europe/Amsterdam` and `UTC+2`. The scan is dated with that offset when the zone agrees with
  it, and keeps its wall clock otherwise. The stated offset also settles the hour the clocks
  repeat in autumn. The merchant's pre-alert and customer-service notes are clocked in UTC.
  The tracker also answers older PDN numbers delivered in Canada, with Canadian zones.
- A scan's `eventCode` stages it. In Transit (`D830`) also carries PDN's intake scan, "We've
  got your package", which is the acceptance. Delivery Exception (`D850`) carries both the
  attempts that did not deliver ("Unable to Deliver - …") and a postponed delivery, which is an
  exception. An Update Message (`D810`) moves nothing.
- The page's line under an out-for-delivery scan, "Expected delivery in 24 - 48 hours", is
  fixed text, not an estimate.
- The proof of delivery, delivery notes and a pickup point's details open only after the
  delivery postcode is confirmed, and are not read. A pickup point's scan loses its location,
  which names the point.

## Limitations

- No delivery estimate, weight or service name.

## Numbers

PDN Express numbers are PDN followed by ten digits. The tracking form shows one as its
placeholder, archived lookups on the tracker hold others, and customers and PDN's replies quote
them on Trustpilot and klacht.nl.

`pdn-express-1` claims PDN and ten digits with high confidence because no other carrier prints
that prefix. Magyar Posta's low-confidence domestic rule takes any P, a letter, three
characters and eight digits, so a PDN number whose last digit happens to fit its check digit
also suggests Magyar Posta; the PDN rule decides. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

One parcel opens on pdn.express under the language folder, `/en/track/`, `/nl/track/`,
`/de/track/` or `/fr/track/`, followed by the number. The tracker's copy-link button builds
that address, and older lookups on tracking.pdn.express used the same path, so the library
reads the number from both hosts.

## Testing

`npm run test:carriers:live -- carriers/pdn-express`, with `PDN_EXPRESS_TRACKING_NUMBER` and
optionally `PDN_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
