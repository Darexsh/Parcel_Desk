# FedEx

Global FedEx tracking from FedEx's official Track API when the deployment has keys for it,
and from the site's own tracking API, captured through a browser. Akamai often refuses even
real browser sessions, so without keys this adapter is unreliable and the router's
universal-provider fallback does a lot of the work.

## How it works

The adapter accepts 12-, 15- or 20-digit numbers (spaces, dots and dashes stripped) and
rejects anything else before any request, except a scanned label barcode, which it tracks by
the number it carries: a 22-digit `96` Ground barcode by its last 15 digits, a 34-digit
barcode by its last 12 behind two zeros. Detection prefers FedEx for a 12-digit number whose
last digit matches (weights 3, 1, 7 from the left, sum mod 11, then mod 10), for a 15-digit
Ground number whose last digit is its GS1 mod 10 check, and for a 22-digit `96` barcode whose
embedded number passes its check; it drops FedEx otherwise. It selects FedEx for a 34-digit
barcode whose embedded number passes its check: no other carrier issues that length but USPS,
whose `420` barcodes can carry zeros where the layout expects them, so behind `420` FedEx is
only suggested, and USPS is selected when its package identifier would be. It also selects
FedEx for a 20-digit Ground Economy number (formerly SmartPost) starting `6129` or `7489`: a
USPS package number without its `92` channel, whose check digit passes with the `92` in front.
The adapter does not enforce that check, so a number someone insists on still reaches FedEx.
The other shapes stay shared: any 22 digits fit Austrian Post, Estafeta and USPS. Without API
keys or a browser service it fails at once with
`ChallengeError('FedEx challenged direct tracking; configure FLARESOLVERR_URL for browser
fallback')`.

1. `api` (only with `FEDEX_API_KEY` and `FEDEX_SECRET_KEY`): the API key and secret key of a
   project with the Track API on [developer.fedex.com](https://developer.fedex.com/), whose
   production keys need a FedEx shipping account. `FEDEX_API_URL=https://apis-sandbox.fedex.com`
   points sandbox keys at the sandbox. The keys buy an OAuth token (`POST /oauth/token`,
   client credentials, an hour long), kept until a minute before it ends, which reads
   `POST /track/v1/trackingnumbers` with `includeDetailedScans`. Neither call is bot-gated.
   The step gets at most 15 s, and at most half the budget when the browser follows.
2. `trawl`: loads `https://www.fedex.com/fedextrack/?trknbr=…` (a shell) with
   `captureResponses` on `POST https://api.fedex.com/track/v2/shipments` and parses the
   captured replies newest first. The browser service retains a bounded sequence of matching
   requests and replies through automatic verification and history loading, with time left
   for cleanup. The browser service has a dedicated FedEx route (see
   [`trawl/README.md`](../../trawl/README.md)):
   - it opens the blank tracker and submits its normal form, every time, because the
     result-page form can ignore a submission or keep the previous route;
   - it keeps the page and context only after a reply that matches the requested number
     (request and response) and has a status or scans;
   - the context stays on its pooled browser and closes after 30 min idle, 2 h total, any
     failed validation, or a browser restart.

## Notes

- The API's reply becomes the same shipment as the page's: `latestStatusDetail` `code` and
  `description` for the package, `scanEvents` `eventType`, `eventDescription` and
  `exceptionDescription` for each scan, `ACTUAL_DELIVERY` and `ESTIMATED_DELIVERY` from
  `dateAndTimes` (else the end of `estimatedDeliveryTimeWindow`), and `holdAtLocation`. Every
  rule below applies to both. A scan's place is its town and its state or province, else its
  country, as the page writes it; its street and postcode are never read. A scan dated
  midnight without an offset keeps its day, as the page's pickup does. Its `NOTFOUND` answer
  is final; any other API failure except recipient verification goes on to the browser.
- A token FedEx stops accepting (401) is replaced once. Keys FedEx refuses are a
  `TransportError` with reason `credentials_rejected` and are not offered again for 10 min.
  429 is `RateLimitedError`, 5xx `UpstreamHttpError`. No failure carries the request, which
  holds the keys or the token.
- A scan read from the API takes over, in place, the row the page's reply stored at the same
  instant with the same stage (and the reverse), so a parcel switching between them is not
  announced twice.
- FedEx writes its generic "On the way" beside a specific scan at the same instant and place,
  as beside "Departed FedEx hub". That copy is dropped; an "On the way" alone at its instant
  or place stays.
- The newest captured reply decides. A captured 401/403 is a `ChallengeError`, so routing
  applies cooldown and fallback; it is not hidden behind an older 200 from the same page.
- A status without usable scans is a partial summary. Compatible history from an earlier
  reply in the same lookup can fill it; otherwise consumers can ask providers for the rest.
  A failed or unreadable final reply does not revive an older success.
- A captured 403 gets one more browser read within the same budget. The service discards
  the refused context, so the second read starts a fresh one, and Akamai's 403 is
  intermittent. A 401 or a challenged page is not repeated.
- Other captured errors: 429 is `RateLimitedError` with its `Retry-After`; 5xx is
  `UpstreamHttpError`; any other 4xx, including 404, is a `TransportError`, never
  not-found.
- A 403 is Akamai's HTML `Access Denied` page; an accepted reply is JSON from the API
  gateway. Chrome reports the 403 to Playwright as `net::ERR_FAILED` because the denial has
  no CORS header; read the status from the network events. Both datacenter and residential IPs get a mix of the two, so it is not a fixed IP
  ban.
- The rendered page is read only to spot a challenge. Its "can't find that tracking number"
  notice appears both for unknown numbers and for refused API calls, so it never means
  not-found.
- An empty `packages` array or `TRACKING.TRACKINGNUMBER.NOTFOUND` error returns an unlocated
  `unknown`. The coded error can echo the number with a default status and an empty scan;
  its placeholders never establish movement or identify FedEx as the carrier.
- A recipient-gated shipment (`TRACKING.AUTHORIZATION.ERROR`) raises `InputRequiredError`
  instead of retrying a verification the adapter cannot supply.
- Results bind strictly to `trackingNbr`. Several matches (same digits, different
  qualifiers) are refused: the qualifier is opaque and picking one risks another
  recipient's parcel.
- Opt-in browser recognition uses the same lookup and requires dated shipment activity.
  It returns the history with its confirmation so callers can reuse it after identification.
- Status uses `keyStatusCD` / scan `statusCD` first, then substring matches on the prose. A
  `DL` code is terminal and outranks the wording. A scan's `provider_code` is its code, the
  page's `statusCD` or the API's `eventType`, which share one vocabulary. The app's review
  (`statusMap`) reads that code first, then the wording, as the parser does; a scan stored
  without a code is staged by its wording. The code is not part of a stored scan's identity,
  which the app keys on its time, place and wording.
- `DY` (delayed) is an exception, except while the newest scan is a pickup "received after
  FedEx cutoff" and the wording names no problem. FedEx flags such a parcel, which leaves on the
  next business day, so it reads as picked up.
- Hold at location: `HL` and `HP` (FedEx's "Ready for pickup (Hold at Location)") are
  `ready_for_pickup`; `RR` (delivery option requested) and `HA` (hold accepted) stay in
  transit. A hold for a problem, such as clearance or a wrong address, carries another code
  and stays an exception. An `OD` scan of a parcel on its way to the hold location stays out
  for delivery, although the page labels it "Heading to pickup location".
- While the parcel is ready for pickup, `pickup_point` is `halCmpnyName` on the first line,
  then `halAddress`: its street lines, and "City, ST 12345" or, without a state or province,
  "postcode city". Without a street or town it is the name alone; without a name, or for a
  residential hold address, there is none. A delivered parcel has none, collected there or not.
- Ground Economy can hand a parcel to the U.S. Postal Service for the last leg. Once a scan
  shows USPS has it (accepted by, at, with or delivered by the U.S. Postal Service, with no
  "not" before it), the result names `usps` as `delivery_carrier` and the USPS package number
  the scan names as `delivery_tracking_number`. Without a named number, only a 20-digit
  Ground Economy number whose check digit passes gets one: itself with `92` in front. A 12-
  or 15-digit number, or a 20-digit one whose check fails, gets a partner only when a scan
  names the USPS number. Most Ground Economy parcels say instead that FedEx Ground delivers
  them, and name no partner.
- Delivered scans are rewritten to "Delivered" because FedEx's line names the signatory.
- Scan times come from `date` + `time` + `gmtOffset`. FedEx sends its pickup (`PU`) with a
  00:00:00 time and no offset. That scan keeps its day in `local_time`, and in
  `last_update_local` when it is the newest, instead of an invented midnight. It sorts by the
  span its day could cover, from UTC+14 to UTC−12, and in FedEx's own order where that span
  overlaps other scans, except that it goes above the shipper's data sent that day: FedEx lists
  it at midnight, below the label it follows. Any other scan without a usable triple keeps no time rather than a
  guessed zone.
- The result's `timezone` is the zone of the place of its day-dated scans, when they share one
  that keeps a single clock. A host starts such a day there; the catalog's UTC would start a US
  pickup on the evening before.
- FedEx enters some transit scans at their planned time, before they happen. A scan dated
  more than five minutes after the lookup is held back until it is due (`plannedScans`).
- FedEx labels a scan it records after a clock change with the offset its place has kept since,
  even when the scan came before: a hub's departure the evening before October's change came
  as +01:00 beside the +02:00 of scans recorded in time. When a scan's place keeps one clock
  (its country's, or its US state's or Canadian province's) and its label is that clock's offset
  at the lookup but not at the scan, the scan is read on that clock at its own date. Spain,
  Portugal and the states and provinces split between zones keep FedEx's label. A scan read
  this way takes over the row an earlier release stored with FedEx's label.

## Mobile API lead

The official [FedEx Mobile APK](https://play.google.com/store/apps/details?id=com.fedex.ida.android)
uses the same `POST https://api.fedex.com/track/v2/shipments` route. Guest application
tokens come from `/auth/oauth/v2/token` with `client_credentials` and `scope=oob`.
The native request adds `x-clientid: ANDR`, `X-experienceid: MOBI`, version/locale
headers and `X-acf-sensor-data` from the bundled Akamai SDK.

Obtaining the mobile token does not clear tracking protection: ordinary HTTP with
the app's request body and mobile headers still receives an HTML 403. Mobile
application identifiers and issued tokens stay outside the repository.

## Rejected approaches

- Plain HTTP to the tracking API, with or without the page's cookies, headers and OAuth
  token: 403. The token endpoint is open; the data endpoint is bot-gated.
- Legacy `trackingCal/track`: 403 for non-browser clients; its `api.ecom.fedex.com` route
  answers 404.
- Copying cookies into a fresh browser context: acceptance does not carry over, while the
  original context keeps working. Hence the retained session in TRAWL.
- Retries in the same context after a 403: replies carry no `Retry-After`, and retries did
  not recover.
- Other browsers: stock headless Chrome gets FedEx's `System Down` shell before the form
  loads; headful Chrome loads the form but its tracking POST gets the same 403. Extra waits
  and pointer or Enter events don't change the outcome.
- Public Akamai tooling ([`infecting/akamai`](https://github.com/infecting/akamai),
  [`OXDBXKXO/akamai-toolkit`](https://github.com/OXDBXKXO/akamai-toolkit),
  [`markswendsen-code/mcp-fedex`](https://github.com/markswendsen-code/mcp-fedex)) targets
  older sensor versions or the login flow, or never checks the tracking API reply itself.

## Limitations

- Cold browser sessions often get 403, and a retained session can lose acceptance at any
  time.
- Sender, recipient, signatory, service description, weight and dimensions are in the reply
  but never read; a test asserts it.
- The API parser and its fixture follow FedEx's published Track API schema.
- The anonymous reply carries the hold-location fields, but no held parcel's reply has been
  captured, so their parsing follows the page bundle. For a hold arranged after shipping
  (exception codes `A12`, `A13`, `015`) FedEx's page shows a guest only the town; if the reply
  leaves out the name or street, `pickup_point` falls back as above.

## Testing

`npm run test:carriers:live -- carriers/fedex` with `FEDEX_LIVE_TRACKING_NUMBER` and
`FLARESOLVERR_URL` set tracks it through the browser; with `FEDEX_API_KEY` and
`FEDEX_SECRET_KEY` instead, through the API alone. The missing-browser check runs without
any of them.

An optional `FEDEX_IPV6_TRAWL_URL` sends the qualifying second browser attempt to
an independent worker. `FEDEX_IPV6_RETRY_PERCENT` selects its share (default 100);
the rest retain the original retry route. The worker must attest actual IPv6
connections to both the public page and tracking API. Missing proof is a transport
failure, never a successful IPv6 answer. The attempt count, total deadline,
whole-number checks and provider fallback remain unchanged. Step telemetry records
the selected route, observed family and presence of dated history.

Custom adapter hosts supply the isolated client as `environment.trawlRoutes["fedex-ipv6"]`. The facade constructs it from `FEDEX_IPV6_TRAWL_URL`; the carrier never constructs a browser service itself.
