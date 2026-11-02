# City Express

City Express is a Serbian courier that delivers parcels door to door across Serbia. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.cityexpress.rs/en/shipment-tracing`, the English tracking
   page, which opens an anonymous session (`JSESSIONID`) and puts its CSRF token in a `meta` tag.
   Then one `GET https://www.cityexpress.rs/htmx-fragment/shipment-trace-by-number-result` with
   `track-trace-page-shipment-center={centre}` and `track-trace-page-shipment-number={eight
   digits}`, the session cookie, the token in `X-CSRF-TOKEN` and `HX-Request: true`, as the
   page's htmx form sends it. No account, key or browser is needed.
2. `retry`: both requests once more, in a new session, when one fails to reach the site or
   hangs. The first try gets half of the budget, so the retry fits in the rest.

- The reply is the HTML the page shows: the status, the shipment's number and details, then the
  scans of each parcel, newest first, each a clock, the depot and the wording.
- An unknown number gets "The shipment with this number does not exist or does not have a status
  yet", which is not found. A shipment entered but not yet scanned gets the same notice.
- A request without the session or its token, or with an expired one, gets the site's own 403
  page, which is inconclusive. Another 403 or a bot-check page is a challenge, and a redirect or
  a 404 a moved route.
- Recognition makes the same requests.

## Notes

- The tracker ignores a centre its form does not offer and then matches the eight digits alone,
  which can return another centre's shipment. The adapter sends only the centres the page's form
  offers, and the reply must print the shipment asked for.
- A shipment number covers every parcel of the shipment; a parcel number covers that parcel
  alone. A shipment of one parcel prints the parcel's number as its own. A scan two parcels
  share is kept once.
- The status above the scans is the shipment's. It decides a delivery, a return or a problem the
  scans have not shown yet, and whether one parcel's delivery ends a shipment of several.
- The English page sets the session's language, so the wording is English. The Serbian wording
  of the same statuses, and the older layout without parcel numbers, are read too.
- Each scan's date and minute have no zone. They stay `local_time` and are read in the catalog
  zone, Belgrade's, since City Express delivers only in Serbia.
- The reply also names the sender's and recipient's postcodes and towns, the sender's
  references, the parcel count and, in some layouts, the sending date and weight. None of it is
  kept.

## Limitations

- No instants, estimate, service, proof of delivery or scan codes.
- The tracker cannot look a shipment up by its eight digits without the centre.
- The page also searches by the sender's reference and partner number; the adapter does not.

## Numbers

City Express shipment numbers are a centre code, 688 001, 688 002 or 688 005, and eight
digits; a parcel within the shipment adds two more digits. Its tracker prints them in groups
and asks for the centre and the eight digits in separate fields. `city-express-rs-1` claims the
fourteen- and sixteen-digit forms that start with one of these centre codes. No other carrier's
sample starts with them, so the rule puts City Express first, and recognition asks its tracker
before the carriers whose rules take any fourteen or sixteen digits. The eight digits alone are a length other carriers print too and
stay unclaimed. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker's address carries the centre and the eight digits as separate parameters, so no
address holds the whole number.

## Testing

`npm run test:carriers:live -- carriers/city-express-rs`, with `CITY_EXPRESS_RS_TRACKING_NUMBER`
and optionally `CITY_EXPRESS_RS_UNKNOWN_NUMBER` set outside the repository.
