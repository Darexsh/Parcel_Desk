# Cyprus Post

Tracks Cyprus Post items, letters and parcels, its own and those other posts send to Cyprus,
through the form of Cyprus Post's own tracking page.

## How it works

The [tracking page](https://www.cypruspost.post/en/track-n-trace-results) is a Laravel form. One
lookup takes three requests, as a visitor's browser makes them:

1. `GET /en/track-n-trace-results` opens an anonymous session, set as a cookie, and renders the
   form with its token and a hidden honeypot pair.
2. `POST /track-and-trace/find` sends the number as `code` with the form's other fields and the
   session cookie. The site redirects to the results page with the number, an expiry and a
   signature in its address.
3. `GET` of that signed address, with the session cookie, renders the item's history on the
   server.

No account, key, CAPTCHA token or browser is needed. The honeypot pair is posted as the page
renders it. Only the session cookies are kept, and none outlive the lookup. A lookup that fails to
reach the site is tried once more in a new session within the budget. Failures carry no request
or response details, as those hold the session, the form token and the signed address.

The results page must hold one item, under the whole requested number, with the English history's
columns; a page in Greek is a schema failure, as its wording and notices are not the ones the
adapter reads. A number without data comes back with the notice "There is no information for this
item", which is the only missing item. A redirect to the home page, a refused form (HTTP 419) and
the "Token has been expired." page of a results link that expired are inconclusive. Block pages,
redirects elsewhere, other notices, HTTP errors and malformed pages keep their own failure kinds.
Recognition uses the same lookup.

## Numbers

The tracker follows S10 item codes, and the adapter takes them with a valid check digit, from any
country; anything else is invalid without a request. The tracker itself answers a mistyped code
as having no data. A code ending `CY` is Cyprus Post's, but the issuer of an S10 code does not
establish who delivers it, so detection keeps such codes with the generic postal carrier and the
low-confidence `cyprus-post-s10` rule makes preflight ask Cyprus Post about them. ACS Courier's
numbers are its own and are not tracked here.

## Notes

Each scan has a wall clock, a country, an office or facility, the UPU's IPS event name in English,
the next office and extra information. The names mostly end with their leg: `(Otb)` in the posting
country, `(Inb)` in the destination and `(Domestic)`. The map reads the name without its leg; the
shared wording rules read most of these names as no milestone. Wording the map does not know goes
to the shared rules. Foreign posts' scans relayed to Cyprus Post use the same names.

Scans are on the clock of the country they happened in. A Cypriot scan is dated on Nicosia's clock,
and a foreign one on its country's when that country keeps a single clock; otherwise, and when the
wall clock is ambiguous at a change of summer time, it is kept as a local time. Countries are
printed as their ISO 3166 English names, cut at 50 characters, and are shown by their usual
English names.

A Cypriot office comes with its postcode and, after it or a dash, its street or district; only the
office's name is kept. A facility abroad can be an office number or a postcode, so a name with a
digit is dropped and the scan keeps its country. The next office is a plan, not a scan, and the
extra information can name who signed, so neither is read. The pickup point is the office named by
the scan that made the item ready for collection, while it waits there or once it was collected
there. The item's category is not read.

## Limitations

The page has no estimated delivery date, service name, weight or proof of delivery. Returns have
not been seen. Items sent to Cyprus, looked up by their foreign code, have only been seen in
archived captures of the tracker.

## Links

Results addresses are signed and expire after a few minutes, and the tracker takes the number only
through its form, so no link opens one parcel.

## Live test

Set `CYPRUS_POST_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/cyprus-post/adapter.live.test.ts`.
Optionally set `CYPRUS_POST_UNKNOWN_NUMBER` to check a number without data.
