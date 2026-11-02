# UPS

Global UPS tracking from UPS's official Track API when the deployment has an app on
developer.ups.com, and otherwise from the site's own `GetStatus` JSON, read through a browser
because Akamai blocks plain HTTP. Parcels handed to a national post for the last mile are
still reported from the UPS record.

## How it works

The adapter accepts only `1Z` numbers and rejects anything else before any request.
Detection selects UPS only when the last digit matches the check digit over the 15
characters after `1Z` (a letter counts as its ASCII code minus 63, mod 10; weights 1, 2
from the left); a mismatch stays a suggestion. No other shape is offered for UPS. Its
[list of formats](https://web.archive.org/web/20250204191042/https://www.ups.com/us/en/support/tracking-support.page)
puts no letter but `T` before ten digits, so the `H`, `J`, `K` and `V` waybills of an
open-source list stay with the carriers whose rules take them.

1. `api` (only with `UPS_CLIENT_ID` and `UPS_CLIENT_SECRET`): the official Track API
   ([api.ts](api.ts)), with the credentials of an app that has the Tracking API product.
   - Buy a token with `POST https://onlinetools.ups.com/security/v1/oauth/token` (client
     credentials over Basic auth) and keep it until a minute before it ends. Lookups share
     one token request.
   - `GET /api/track/v1/details/{number}` with the token, a fresh `transId` and
     `transactionSrc`. It gets at most 15 s, and never more than half the lookup's time.
   - UPS's not-found answer (warning `TW0001`, alone or with HTTP 404) and a check-digit
     refusal end the lookup. Any other failure, a refusal of the credentials included,
     goes on to the browser.
   - `UPS_API_URL` points the step at another host, such as UPS's Customer Integration
     Environment `https://wwwcie.ups.com`. It must be https; otherwise the step fails.
2. `trawl` (whenever a browser service is configured): loads
   `https://www.ups.com/track?loc=en_US&tracknum=…&requester=ST/trackdetails` with
   `captureResponses` on `POST https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US`
   and parses the latest matching reply the page itself received. A refusal or malformed
   final reply overrides older successful replies. With no matching capture, or a final
   HTTP 428 verification response, it parses the rendered page instead: current status
   and, once delivered, where, with no history. That answer is marked `summary_only`, so
   an enabled provider can supply the history.
   Its ship-to town is the recipient's, never the banner's place.
3. `direct` (only without a browser service): plain HTTP with an in-memory cookie jar.
   - Fetch the tracking page, check it set the `X-XSRF-TOKEN-ST` cookie, then POST
     `GetStatus` with that value as the `X-XSRF-TOKEN` header. Cache the session.
   - A cached session that gets rejected fetches the page once and retries; a second
     rejection drops it.
   - If the API call fails recoverably, the fetched page is parsed as a rendered page. Otherwise it fails
     with `ChallengeError('UPS challenged direct tracking; configure FLARESOLVERR_URL for
     browser fallback')`. Rate limits retain their own error and retry hint.

In practice Akamai holds `GetStatus` open until the timeout (20 s direct) for any session a
browser did not establish. A deployment without a browser service therefore gets only the
rendered status, after that wait.

## Notes

- The API's reply becomes the same result as the page's: the same codes, stages, clock
  rules and ship-to country. Its towns come in capitals and its places as codes; they are
  written like the page's ("Koeln, Germany", "Des Moines, IA, United States"), so a scan
  read once from each source stays one scan. The page writes a delivery's place, and its
  delivered banner's, the API's way ("KOELN, DE"), and it is rewritten the same way. The API names no access point, so its result
  has no `pickup_point`.
- Credentials UPS refuses (HTTP 400, 401 or 403 for a token, or a second 401 on a fresh
  token) fail the step at once for ten minutes, as a transport failure, instead of asking
  again on every lookup. Errors carry neither the credentials nor the token.
- The status type (`D`, `I`, `P`, `M`, `X`) sets the status only when the newest scan's code,
  notices aside, is unmapped.
- Lookups are serialized per adapter instance: the jar and XSRF token are shared, and two
  concurrent refreshes produce a session that belongs to neither.
- Direct HTTP 401/403/419, or a page with no token, raise `UPSSessionRejected` (a
  `ChallengeError`), which the refresh-once logic reacts to. Any other HTTP error, including
  404 but excluding 429, is indeterminate: it proves nothing about the parcel and must not start a not-found
  cooldown.
- HTTP 429 from a direct request, captured status call or browser page stays rate limited.
  Numeric and HTTP-date `Retry-After` hints are retained. A throttled session is neither
  refreshed nor discarded, and rendered HTML cannot hide the throttle.
- UPS's status call answers HTTP 500 in bursts. Within one, the browser's call failed again
  for lookups that followed within minutes and was answered after a longer pause. The page
  also fails in bursts: it stays on Akamai's interstitial, or every browser tier fails
  outright, until the browser service runs out of tiers or time, and the service answers
  HTTP 500 itself. After a captured 500, or a failed last browser tier, the `trawl` step
  rests for five minutes per browser service, shared by every tracker in the process: it
  fails at once with `UPSStatusHeldError` (indeterminate), which the step record names, and
  the caller's next source answers. A restart forgets the rest.
- `direct` is disabled whenever a browser exists, with no cooldown probe: every probe costs
  the full direct timeout and hits the same block.
- Each scan's `actCode` is kept as `provider_code` and mapped to a stage
  ([statuses.json](statuses.json)). One wording can cover two codes: `OR` and `AR` both read
  "Arrived at Facility". An unmapped code gets no stage; the sync classifies its wording.
  A scan UPS sends with an empty code, like the clearing agency's customs note, is read only
  by its whole wording as the map records it.
- The newest scan's code sets the current stage and status. `progressBarType`, then the
  prose, decide only when that code is unmapped. The token reads `Exception` for a mere delay,
  and the prose's "will be delivered" is a delivery still to come, not one.
  The receiver's delivery instructions (`L0`) are a notice, not a scan: the scan before them
  decides, so a parcel UPS has only the label for does not read in transit. An acceptance
  code after the delivery leg, such as the "Pickup Scan" when UPS collects a parcel from the
  access point it waited at, is transit.
- Duties or taxes due (`7F`) and the hold until they are paid (`OQ`) set `recipient_action`
  to `duties` by their code, whatever words UPS adds beside it.
- UPS's reminder to collect a parcel before its hold ends (`5G`) is `ready_for_pickup`: the parcel
  is returned only if no one collects it. It does not say where the parcel is held.
- `pickup_point` names the access point only while the newest scan is `2Q` or `ZP`. Replies
  can carry an access point the parcel never reached. It is the business name, then the
  street and the town on their own lines when `upsAccessPoint.location` gives both, as the
  tracking page shows them. The attention name is never read: it can name a person.
- `delivered_at` is the delivering scan's time; `destination_country` the ship-to or delivery
  country code.
- `service_name` is the service `additionalInformation.serviceInformation` names, without
  the trademark signs UPS adds to it.
- A parcel UPS hands to the U.S. Postal Service for the last leg (Ground Saver, for one) has
  its USPS number in `additionalInformation.postalServiceTrackingID`, which the page offers
  as USPS tracking. It becomes `delivery_tracking_number` with `delivery_carrier` `usps` only
  when it reads as a USPS package number; a routing barcode keeps the package number after
  its ZIP code. `LX`, `YH` and `YC` are the hand-off, the post office's receipt and its
  delivery.
- Prose arrives HTML-escaped (`We&#39;re`, `&#174;`) and is decoded.
- A 402 "Invalid Request" for a number whose check digit fails is `InvalidInputError`, from
  either step. Other refusals stay indeterminate.
- A reply naming another number is a `SchemaError`, and so is one with several parcels
  unless exactly one names the number.
- Error 504 in a successful reply that names the number is `NotFoundError`, from either step:
  UPS has no record of it, expired or not active yet, and its own page reads the code that
  way.
- Error 298 or 299, as the reply's status or a parcel's error, is `UPSUnavailableError`, an
  `IndeterminateError`, from either step. UPS's page reads them as "the system is temporarily
  unavailable". The rendered page never stands in for them. Other error codes keep the
  "could not locate" result.
- The app scan-identity policy updates a scan when UPS adds its location, provided its
  exact instant, wording and known stage agree. Conflicting locations and distinct
  messages at one instant remain separate. Wording is compared with HTML escapes decoded.
  Two scans with activity codes must share the code rather than the stage, and their town
  rather than their wording: the API leaves out the page's second sentence ("— Your
  package is on the way"). A scan stored before codes were kept was staged by its
  wording, so a coded scan need not share its stage.
- The rendered-page parser reads only the active progress-bar milestone. Reading the whole
  bar classified label-created parcels as out for delivery. The banner's one event has no
  code; "Label Created", "On the Way", "Out for Delivery" and "Delivered" get their stage from
  the map, other banners none. Coded scans' wording is never read without its code.
- Each scan comes as a UTC pair and a local pair with the place's `gmtOffset`. The time is the
  UTC pair's instant, to the second, written on that offset when the local pair reads the same
  minute on it, so a consumer reads the scan's day where it happened; otherwise, or at a zero
  offset, it stays `+00:00`. Without the UTC pair the local pair and its offset are the time.
  A local pair without an offset stays `local_time`, a scan dated by its day alone, as some
  drop-offs are, keeps that day as `local_time`, and other text stays `provider_time_text`;
  no zone is guessed. Some label scans come with no clock and get none.
- UPS can state the offset a place keeps in the other season. After the clocks went back it
  dated deliveries in France on the summer offset: each reached its answer an hour after the
  instant that offset gives, and the wall clock was the place's. A scan whose offset its
  place's zone cannot have at that wall clock, but has at another time of year, keeps the wall
  clock as `local_time` and is dated in that zone (`time_zone_basis` `place`). Only countries
  with one civil time have a zone here, without Spain and Portugal, whose islands keep the
  mainland's other-season offset. The scan keeps its stored row (`matchWallClock`).
- UPS enters some departures and loadings on the delivery vehicle at their planned time,
  before they happen. A scan dated more than five minutes after the lookup is held back until
  it is due (`plannedScans`).
- The scheduled delivery date has no year. The adapter picks the year that puts it within
  the last week or in the future.
- The canary URL is a static PDF so the canary itself is not challenged.

## Mobile API lead

The official [UPS APK](https://play.google.com/store/apps/details?id=com.ups.mobile.android)
delegates tracking to native code despite also containing a React Native bundle.
Its detail read is `POST https://onlinetools.ups.com/api/molws/v2/tracking/details/{number}`
with locale, an empty nickname body and a bearer token. Set both
`AddPackageToTrackHistory` and `GetNicknameFromTrackHistory` to false for an
independent lookup. The separate `TrackHistory` methods modify saved tracking
records; they are not the parcel's scan feed.

Guest tokens use `/security/v1/distributed-apps/authorize` and `/token` with
`audience: anonymous` and a code challenge/verifier. The request builder also
sends version and `X-Firebase-AppCheck` headers. Plain HTTP guest authorization
is rejected with 401; the presence of the App Check header alone does not establish
whether attestation is enforced. This route needs a verified guest session before
it can replace browser retrieval. Application configuration and tokens stay outside Git.

## Rejected approaches

- Calling `GetStatus` without loading the page first: 401 without the page's cookies.
- Replaying the browser's cookies over plain HTTP: Akamai holds that call open too, from
  datacenter and residential IPs alike.
- Parsing the rendered page as the primary path: it has no history.

## Limitations

- No delivery window or dimensions. The weight field comes back empty.
- No sender name: `senderShipperNumber` is the shipper's account number.
- Without API credentials or a browser service there is no history.
- The ship-to address beyond its country, the signatory, the proof-of-delivery link and the
  access point's attention name, hours and coordinates are in the reply but never kept; a
  test asserts it.

## Testing

`UPS_CLIENT_ID=… UPS_CLIENT_SECRET=… npm run test:carriers:live -- carriers/ups/api.live.test.ts`
checks the credentials on a synthetic number; `UPS_LIVE_TRACKING_NUMBER=…` adds a real
shipment read through the API alone. The wrong-number canary in
[`testing/browserProtectedCarriers.live.test.ts`](../../testing/browserProtectedCarriers.live.test.ts)
accepts either a clean no-result or the exact challenge error above:
`npm run test:carriers:live -- testing/browserProtectedCarriers.live.test.ts`.
