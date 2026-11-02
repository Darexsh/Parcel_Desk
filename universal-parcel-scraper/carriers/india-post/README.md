# India Post

India Post (Department of Posts, including Speed Post) S10 items ending in `IN`, tracked through
[MySpeedPost](https://myspeedpost.com/track), a third-party tracker that answers without an account.
India Post's own site is interactive, rate-limited and does not answer anonymous programmatic
requests reliably.

## How it works

1. `direct`: one stateful Livewire conversation with MySpeedPost. A per-lookup cookie jar
   (`fetch-cookie` + `tough-cookie`) carries the page's session cookie to every call and keeps
   concurrent lookups from sharing a component snapshot.
   1. `GET /track?n={number}&sync=true`; read the `track-consignment` component's `wire:snapshot` and
      the CSRF token.
   2. If the component is already `Completed`, its `tracking-request` attribute holds MySpeedPost's
      cached history. If `synced_at` is under 30 minutes old, or the page carries a Turnstile
      widget, return it. Otherwise dispatch `refresh_consignment` (the page's Refresh button) and
      poll; if the refresh fails, return the cached history.
   3. Otherwise `POST /livewire/update`: `__dispatch(set_consignment_number)` + `submit` for a `New`
      component, `fetchStatus` for one already `Processing`.
   4. Poll `fetchStatus` (up to 10 × 750 ms) until `Completed`, then parse the returned HTML fragment.

Outcomes:

- `consignment_not_found` dispatch: not found.
- Cloudflare interstitial (HTTP 401/403/419/429, `cf-mitigated: challenge`, or `Just a moment`,
  `cf-chl-`, `_cf_chl_opt` in the body): `IndiaPostChallengeError`, retryable, never not-found.
- Still `Processing` after the poll budget: `IndeterminateError`. The backend answered but proved
  nothing, so no not-found cooldown.
- A `log_event` dispatch named `tracking_rate_limited`: `RateLimitedError`. The component stays
  `New`, and from then on the form carries a Turnstile widget.
- A `New` page with a Turnstile widget, or a `turnstile-reset` dispatch: `IndiaPostChallengeError`.
  No token is sent, so the lookup stops before submitting.
- Any other component state: the completed history the HTML still carries, else
  `IndeterminateError` naming the state.

## Notes

- Stale caches are refreshed because MySpeedPost serves its last sync until someone presses Refresh;
  `sync=true` does not renew it. A cached "Item Booked" can hide days of later scans.
- MySpeedPost rate-limits after a handful of fresh lookups in a row.
- Cloudflare's passive loader `/cdn-cgi/challenge-platform/scripts/jsd/main.js` appears on ordinary
  200 pages. Treating `challenge-platform` as a challenge marker once made every lookup fail.
- Identity is bound twice: the snapshot's `consignment_number` and the fragment's
  `#consignment_search` value must both match.
- `event` is either prose (older syncs) or a bare code (`ITEM_BOOK`, `BAG_DISPATCH`,
  `CUSTOM_RECEIVE`…). Known codes are spelled out, with `ITEM_BOOK` → "Item Booked" to match the old
  prose so stored rows don't duplicate. Other codes become title case.
- Most rows have no stable status code. `event_type`, `event` and `remarks` are joined into one normalized
  key and matched by substring, most specific first; "lost" must be a whole word. Unrecognized rows keep
  an `in_transit` stage with an `unknown` status, so no scan is dropped and no terminal stage is invented.
  The parcel app's review (`statusMap`) reads a stored scan's code and wording the same way, without
  the remarks it does not keep, which can give a row another stage. It leaves an unrecognized row
  open, so the review shows wording no rule knows.
- `CUSTOM_RECEIVE` is customs. `CUSTOM_RETURN`, "Out of Export Customs" and "released by export Customs" mean customs handed
  the item back: in transit, not returned to sender.
- `tracked_at` without an offset is read as `Asia/Kolkata`. `synced_at` is returned as
  `source_synced_at`.
- The Consignment Details card's Article Type ("Inland Speed Post", "Foreign Speed Post
  Merchandise") becomes `service_name`.
- The page's Destination card names the destination country. It becomes `destination_country`
  (or `destination_country_name` when the name has no ISO code), so the host can confirm the S10
  number with that country's post.
- Rows the destination's post scans carry its office's wall clock, labelled as India's: La Poste's
  scans read 3.5 h early in summer. They run from the first row marked `(Inb)`, or the first flight
  arrival whose route lands in the destination country, to an outbound mark, a transfer to the
  office of exchange or an arrival elsewhere. Replies for the same item alternate between prose with
  `(Inb)` marks and bare codes without them, so both signals are needed. These rows are read in the
  destination's zone; for a country with several zones or none known they keep the wall time in
  `local_time` with no offset. Flight rows keep their own reading.
- A take-off row (`event_type` `AircraftTakeOff`, whose office starts with the airport's code as in
  `Office - DEL 00000000`) carries the departure airport's wall clock labelled `Z`: a take-off was
  seen recorded hours before its labelled time. Its digits are read in the airport's zone, from a
  table of airport codes in the adapter. The row is found by its code because its wording changes.
  A take-off at an airport outside the table keeps its label, and one whose label is not UTC is
  read like any other row.
- Take-offs use one wording even when the source switches labels. A strictly formatted flight remark
  supplies its flight number and route; other remarks are discarded. Known departure airports are
  named with their country so maps can locate the scan. A departure's route does not prove arrival.
- `MailArrived` with a matching flight remark places the arrival at that flight's destination;
  its office field still names the origin. The description keeps the arrival's own flight number
  and route, and the location excludes the origin's pincode and directory coordinates. Ordinary
  sorting arrivals without a matching flight remark keep their office. Arrival timestamps retain
  their supplied offset; the take-off clock correction does not apply to them.
- The app identity policy requires the same instant and provider code before updating a
  reworded stored scan. Its `relabelledFrom: 'Asia/Kolkata'` lets a scan abroad take over the row
  stored under India's label, by wall clock, provider code and location. The consumer owns the
  stored rows and notification receipts.
- IDs and pincodes arrive as numbers or strings, hence `cleanScalar`. A pincode is kept in the
  location only when it is exactly six digits and does not start with 9: those belong to the Army
  Postal Service, which India Post also gives foreign mail, and place no office.
- "Office -" followed at most by a code (`Office - 00000000`, `Office - FRA`) stands for an office
  India Post does not name. The location leaves it out and keeps the pincode alone, unless the code
  names an airport abroad: the office of exchange there carries an Indian office's pincode.
- A row's `pincode_info` is MySpeedPost's directory entry for the pincode, not for the office:
  "KOLKATA FOREIGN LCAO 900056" comes back as an office in Delhi, and unverified entries can be
  hundreds of kilometres off. Its coordinates become the scan's `point` only when the entry is
  verified and names the scan's own office. The rest of the entry is never kept.

## Limitations

- No ETA.
- Only booking, dispatch, customs, flight and delivery rows have been seen live. Failure, return and pickup rules
  come from prior art ([njs-tracker-scraper](https://github.com/bivu-m/njs-tracker-scraper)).
- Recipient details, addresses and contact numbers are never retained. Only strictly formatted
  flight remarks supply display text; the offline test asserts it.

## Testing

`npm run test:carriers:live -- carriers/india-post` with `INDIA_POST_TRACKING_NUMBER`
set to a real consignment. The synthetic not-found case runs without it.
