# DPEX Worldwide

DPEX Worldwide is an express and e-commerce network across Asia, with its own stations in
Singapore, Hong Kong, China, Australia and nearby countries. Its tracker is a GETOnline page
that Frontier Force hosts for it under the member id `stid=dpexwwe`, and DPEX China runs a
trace-and-track system of its own. Tracked through both.

## How it works

1. `direct`: two requests at once, each sent once more after a network failure. Neither needs a
   cookie, token, key or browser.
   - `GET https://tracking.frontierforce.com/go/plm-tracking?stid=dpexwwe&cn={number}`, the page
     dpex.com's track-and-trace page frames. The server writes the history into the page's
     script, newest first within each of the page's sections: for each scan the number, the
     event's wording and number, its location and its clock.
   - `GET https://erp.dpex.com.cn/trace-and-track/index?id={number}`, the page dpex.com.cn's
     search opens. The server writes the history into the page's script as JSON, oldest first:
     for each scan the number, the station's clock, the event and, in a list beside it, the
     place.

- The GETOnline page and its parser are the ones SkyNet Worldwide Express uses, shared in
  [`getonline.ts`](../skynet-worldwide/getonline.ts).
- The GETOnline page shows an air waybill it holds without scans as not found, while DPEX China
  can have its history. DPEX China's system holds the scans its stations enter by hand, such as
  the documents, the collection and the first legs, and copies in the platform's.
- The GETOnline history leads, as its clocks can carry a zone, followed by DPEX China's scans
  from before its first one. DPEX China's history stands alone when it holds a later scan, and
  each tracker's history stands alone when the other has none. Both write the station's wall
  clock, so the scans compare across them.
- A number is unknown only when both trackers say so: the GETOnline page's "No tracking found"
  notice and DPEX China's "No track found" entry. Otherwise the failure that kept a tracker from
  answering is reported. A 404 or a redirect is a moved route, an empty page is inconclusive and
  a firewall page is a challenge.
- Every scan must name the number asked, and DPEX China's summary must echo it.
- Recognition makes the same requests.

## Notes

- `stid` picks DPEX's records as well as its branding: another member's id does not find a
  DPEX air waybill. The adapter sends only `dpexwwe`.
- The GETOnline tracker reads `%` as a wildcard and answers short references with other
  people's shipments, so the adapter sends only twelve digits that pass the check digit.
- Each GETOnline scan's clock is the station's wall clock to the minute, with no zone. Scans in
  a country with one clock, such as Singapore, Malaysia or China, are dated on it. Scans in
  Australia, and in Hong Kong, whose name the shared country lookup does not read, stay
  `local_time`.
- DPEX China's scans stay `local_time`. Its UTC fields apply the offset of the station that
  entered the scan, not the scan's place, and many places name no country.
- Both trackers write the same event numbers, which stage a scan. The documents prepared before
  the collection are a registration.
- The service type, the masked signatory and the destination's town are not kept, nor DPEX
  China's notes on a scan, which can name who signed, and its references. The proof of
  delivery, behind a check of the recipient's phone number or email, is not read.
- The track-and-trace page's search button opens `dpexonline.com/trace-and-track/index?id=`,
  another copy of DPEX's own system, which did not know air waybills the other two track. The
  adapter does not ask it.

## Limitations

- No ETA, weight, service name or delivery time as an instant.
- No hand-off: neither tracker names a delivering partner or its number.

## Numbers

DPEX air waybills are twelve digits whose last digit is the first eleven modulo 7. No rule
claims them: Yamato, Sagawa and Japan Post print twelve-digit numbers with the same check
digit, so preflight does not ask DPEX. A number reaches the adapter when the user, a link or a
provider names the carrier. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The dpex.com track-and-trace page opens air waybills from its `cn` query parameter, several
separated by commas, and frames `tracking.frontierforce.com/tracking_search.aspx?stid=dpexwwe`
with them; the former `/Tools-And-Applications/Track-And-Trace` address redirects there with the
same parameter. The page's search button, dpexonline.com and DPEX China's system open
`/trace-and-track/index` with the numbers in `id`. On `tracking.frontierforce.com`, the library
reads `cn` only when `stid` is `dpexwwe`.

## Testing

`npm run test:carriers:live -- carriers/dpex`, with `DPEX_TRACKING_NUMBER` and optionally
`DPEX_UNKNOWN_NUMBER` set outside the repository.
