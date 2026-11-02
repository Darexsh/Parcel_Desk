# FleetOptics

FleetOptics is a final-mile parcel carrier for online retailers in Ontario, Quebec, Alberta and
British Columbia. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://track.fleetopticsinc.com/?tracking_number={number}`, as the
   page's search form sends it. It needs no cookie, token, key or browser. The server renders
   the parcel's summary and its tracking history, newest first, into the page.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with the notice `Tracking number not found.` in place of the
  summary and the history, which is not found. Another notice is inconclusive. A 404 is a moved
  route.
- The page repeats the number only in its search field, which must be the number asked. The
  service redirects a number that is not a parcel's own barcode, such as one in lower case, to
  the barcode's page, so the adapter asks in capitals and reads a redirect to another number as
  inconclusive. A shortened number is not found: the lookup matches the whole number.
- A firewall or bot check's page in place of the tracker, even with HTTP 200, is a challenge.
- Recognition makes the same request.

## Notes

- Each row has a day and month without a year, and a time with a zone label, `ET`, `MT` or
  `PT`, that names the destination's zone. The year is the latest that does not put the row
  after the lookup; the tracker keeps parcels for some months.
- An Eastern clock matches the service's own records and becomes an instant. On a page for a
  parcel in another zone, the first row is three hours early and a scan at a terminal in another
  province carries the destination's label, so those clocks stay local, with the label's zone
  as the result's timezone.
- The row's wording stages it. A failed visit, `Unable to Deliver` with the reason after a dash,
  is a failed attempt, after which the parcel goes out again; a delivery carries where the
  parcel was left. Wording the map does not know goes through the shared wording rules.
- A row's place is the town and province. A place with a digit, which could be an address or a
  postcode, is not kept.
- The summary's estimate is a weekday and a day, such as `Thu, Sep 17`, read in the year nearest
  the lookup with that weekday. On the delivery day the page gives today's time window, which
  becomes today's date. The delivered row dates the delivery when its clock is an instant.
- The page puts the recipient's postal code into its script and the delivery photos' addresses
  into its HTML, then asks the visitor for the postal code before it shows the photos and the
  map. The adapter keeps neither, nor the delivery preferences link.
- Archived lookups show the service's API, `foxapi.fleetoptics.ca/api/track-parcel-cons`,
  taking the number with the recipient's postal code. The page needs no postal code for the
  history, so the adapter does not use the API.

## Limitations

- No weight, service, sender or recipient.
- Outside the Eastern zone, scan times are wall clocks and the first row's is three hours early.
- The tracker drops a parcel some months after delivery and then answers that the number is not
  found.

## Numbers

FleetOptics labels carry `F`, a code for the shipper and a run of digits, sometimes with
letters: archived lookups on the tracker show seven shipper codes with fixed lengths, which
`fleetoptics-1` claims. Other shippers' codes and lengths are not known, so the rule covers
only these; the adapter also takes `F`, three to five letters and seven to sixteen letters and
digits starting with a digit. The tracker files some retailers' package IDs, `SON1` and ten
digits, as the parcel's own barcode, and the adapter takes them; they name the shipper rather
than the carrier and stay unclaimed. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking form on `track.fleetopticsinc.com` sends the number as `tracking_number`, so
`track.fleetopticsinc.com/?tracking_number={number}` opens one parcel; its French page is
under `/fr/`. The older `delivery.fleetopticsinc.com/tracking/` and `fleetopticsinc.ca`
portal addresses carry the same parameter; the library reads the number from all of them.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/fleetoptics`, with `FLEETOPTICS_TRACKING_NUMBER` and
optionally `FLEETOPTICS_UNKNOWN_NUMBER` set outside the repository.
