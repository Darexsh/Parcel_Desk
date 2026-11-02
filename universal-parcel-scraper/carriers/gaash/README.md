# GAASH Worldwide

GAASH Worldwide is an Israeli e-commerce import line. It flies online orders to Israel and
clears them through customs, then delivers them itself or hands them to the company that does:
HFD, Mailog or Chita. Tracked through the lookup its tracking page makes. Mailog's own tracking
page embeds the same tracker.

## How it works

1. `direct`: one `GET https://gaashwd.com/track-parcel/` for the WordPress nonce the page's
   settings give every visitor, then, together as the page sends them, `GET` on
   `https://gaashwd.com/wp-json/gaash-parcel-status-tracker/v1/parcel-tracking-data` and
   `.../parcel-status-data`, each with `?parcel_id={number}&lang=en` and the nonce in
   `X-WP-Nonce`. It needs no cookie, key or browser. The first reply has the scans, oldest first;
   the second the parcel's customs and delivery status.
2. `retry`: a read that fails to reach the site, or hangs, gets one more try within the budget.

- An unknown number is HTTP 200 without a parcel from the scans route and HTTP 404 with
  `no_data` from the status route, which the page reports as not found. Replies that disagree
  are inconclusive, and another 404 or a redirect is a moved route.
- WordPress refuses a missing or expired nonce (`rest_forbidden`, `rest_cookie_invalid_nonce`).
  The nonce is kept for an hour, and a refused one is read again from the page once.
- The scans must be the number asked's, as the parcel's `TrackingNumber` or its `HAWB`, and the
  status reply's `Hawb` must be the same parcel's. `SearchTrackingNumber` only echoes the query.
- Recognition makes the same requests.

## Notes

- Each scan's `StatusTime` is the wall clock in Israel and its `TimeZoneOffset` the offset Israel
  had that day, `GMT+02:00` in winter and `GMT+03:00` in summer, so scans are instants. The
  departure abroad is stamped the same way.
- The `StatusCode` stages a scan. `lang=he` gives the same English wording, so the adapter asks
  in English.
- The status reply decides a delivery, a return, a lost or damaged parcel and a customs clearance
  that cannot go on (`FinalStatuses`). It does so only for a parcel GAASH delivers itself, as on
  the page.
- `PudoDetails`, the pickup point the page shows, is kept as the pickup point: its name, then its
  address after the first comma.
- For a parcel another company delivers, the page names HFD, Mailog or Chita and their contact
  details, but no number of theirs, and none of them is in the catalog, so there is no hand-off.
- The replies also hold the merchant, the courier, payment links, required documents and
  permits, and each scan's pickup point code and collection code. None of it is kept.

## Limitations

- No scan location, estimate, weight or service name.
- Scans stop once a parcel GAASH does not deliver itself clears customs.

## Numbers

GAASH's tracker answers three layouts: `GWD` and nine digits, `GAIH` and eight digits, and `PH`
and ten digits, which the tracker also gives as the HAWB. The adapter accepts those alone. Only
one public number of each is known, so no rule claims them; the adapter tracks them when GAASH
is chosen. Purolator's three-letter rule leaves the `GWD` prefix out, and the other two get only
weak suggestions from other carriers. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`gaashwd.com/track-parcel/?TrackingNumber={number}` opens the tracker on one parcel: its script
reads `TrackingNumber`. Archived lookups pass the same parameter to the home page and to the
Hebrew tracker page.

## Testing

`npm run test:carriers:live -- carriers/gaash`, with `GAASH_TRACKING_NUMBER` and optionally
`GAASH_UNKNOWN_NUMBER` set outside the repository.
