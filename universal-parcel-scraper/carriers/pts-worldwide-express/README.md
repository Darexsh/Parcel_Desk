# PTS Worldwide Express

PTS Worldwide Express, known to customers as PTS Kargo, is a Turkish courier for international
express and domestic e-commerce parcels. Abroad, and for some shippers in Turkey, a partner such
as UPS, Cainiao or HepsiJET delivers the parcel under its own number. Tracked through the lookup
its tracking page makes.

## How it works

1. `direct`: one `GET https://tracking-api.pts.net/tracking?trackingNumber={number}` with
   `Accept-Language: en`, as the page at tracking.pts.net sends it. It needs no cookie, token,
   key or browser. The JSON reply has the shipment's summary, its countries, its delivery
   partner and its scans, oldest first.
2. `retry`: one more attempt after a failure to reach the tracker, inside the budget.

- An unknown number is HTTP 400 with the error code `T404`, which the page reports as not
  found. Any other error code is inconclusive. A 404 or a redirect is a moved route.
- The shipment must carry the number asked as PTS's own number or as its partner's.
- Recognition makes the same request.

## Notes

- The reply gives each scan with a UTC offset, and the pages show it in Istanbul time. The scans
  PTS relays from its partners abroad are their wall clocks stored as Istanbul's, so every scan
  is kept as the Istanbul wall clock the page shows, in `local_time`.
- Scan codes stay the same in every language and stage the scans, including partners' scans.
  A transfer delay notice moves nothing and has no stage. Cleared customs is in transit.
- The summary stages a parcel without staged scans. The step the English page labels In
  Customs is the one the Turkish page calls the destination warehouse, so it reads as in
  transit.
- The tracker repeats some scans; each is kept once.
- A parcel asked by its partner's number can have no scans of PTS's, and the page then shows
  only its summary, such as In Progress. The adapter returns that summary, with PTS's own number
  as the canonical number.
- The reply names the partner, its tracking link and its number. The hand-off names the partner
  only when its name and link give one catalog carrier and the number has that carrier's shape.
  HepsiJET claims no shape, so its number must be the one its own tracking link opens. A USPS
  routing barcode loses the ZIP code it opens with. The link is never followed.
- The reply has an estimated delivery date, which neither page shows, so it is not kept. The
  masked address, the postcode and the origin country are not kept either.
- The page at wp.pts.net posts the number in a form with a session and renders the same
  shipment; the JSON lookup needs one request.

## Limitations

- No weight, no estimate and no delivery time as an instant.
- A parcel PTS hands to a domestic partner can have only PTS's summary; its scans are with the
  partner.

## Numbers

PTS's waybills have ten digits: archived lookups on its trackers, customer complaints and its
current tracker show them. Complaints about Nike orders it delivered also quote fourteen-digit
numbers starting 9001, which the tracker finds as the number of HepsiJET, the partner that
delivers them. The adapter takes both shapes.

No rule claims PTS numbers. Ten and fourteen digits are lengths many carriers share, and the
9001 numbers have only been seen with one shipper. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`tracking.pts.net/{number}` opens one parcel. The former tracker took the number in the
`trackid` parameter of `/sqlptstrack.php` on pts.net; archived lookups show it, and the library
reads the number from such addresses.

## Testing

`npm run test:carriers:live -- carriers/pts-worldwide-express`, with
`PTS_WORLDWIDE_EXPRESS_TRACKING_NUMBER` and optionally `PTS_WORLDWIDE_EXPRESS_UNKNOWN_NUMBER`
set outside the repository.
