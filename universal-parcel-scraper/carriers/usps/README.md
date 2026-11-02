# USPS

United States Postal Service tracking from the server-rendered tracking page, loaded in a
browser because Akamai blocks plain HTTP. Also covers incoming international mail that keeps
its original S10 number when USPS delivers it.

## How it works

The adapter accepts 20- or 22-digit labels, checksum-valid 26-digit IMpb identifiers,
and checksum-valid UPU S10 numbers with any country suffix. Scanned IMpb barcodes
may include a five- or nine-digit routing ZIP after `420`; the adapter strips only
a uniquely valid routing prefix before querying and checking response identity, and
reports the package identifier as `canonical_tracking_number` so a consumer can keep
the number without the recipient's ZIP code. When both readings of a 34-digit barcode
pass the check digit, the one whose Mailer ID fits its channel is kept; when both or
neither fit, the barcode is rejected.
[Publication 199](https://postalpro.usps.com/pub199) defines that structure and
the PIC checksum and its channel identifiers: `92` to `94`, plus retail `95` and the
legacy `91` on 22-digit PICs.
A 22-digit PIC selects USPS when its check digit passes and its Mailer ID fits the
channel: nine digits starting with 9 for `92` and the legacy `91`, six digits
starting with 0 to 8 for `93`. A 26-digit PIC on channel `92` selects USPS by the
same test; one on `93` stays a suggestion. Austrian Post and Estafeta also issue 22-digit
numbers, but none known starts with a USPS channel. DHL eCommerce tracks the `9261`
and `9361` families as well, so those stay suggestions. A routing barcode selects USPS
when its PIC would, unless a ZIP+4 add-on starting with 92 to 94 could also open a
26-digit PIC. Other matching IMpb rules prioritize USPS as a candidate. None of them
establish shipment existence.
Opt-in browser recognition reuses the lookup
and requires dated activity. Anything else is rejected before a request. Without a browser service it
fails at once with `ChallengeError('USPS challenged direct tracking; configure
FLARESOLVERR_URL for browser fallback')`.

1. `trawl`: the browser service loads
   `https://tools.usps.com/tracking/…`, runs the interstitial check, and
   waits for the visible tracking number before the rendered DOM is parsed. The verification
   page can finish loading before it reloads into tracking, so network idleness alone is
   insufficient. There is no tracking XHR to capture: the page carries its data
   as HTML.

The verification wrapper can stay blank when its tracking request redirects to
USPS's service outage page. The service captures that exact redirect. It concerns one
read, but redirects come in runs: a second read loads the page about one time in three
and a third about one in ten, and after a lookup whose reads were all redirected the
next lookup's first read loads about one time in ten. So a redirected read gets one more
read, and once three reads in a row through one browser service are redirected, its
reads pause for five minutes: lookups end at once with the wait, and enabled providers
take over. The first read after the pause pauses them again if it is redirected; a page
that loads ends the run. A lookup whose every read is redirected ends as temporary
unavailability. An unresolved verification page remains a challenge; a complete matching
history takes precedence over an earlier outage reply.

Parsing, in order:

- No `.track-bar-container`: `ChallengeError`. A browser can get HTTP 200 containing only a
  JavaScript challenge.
- `#trackingNum` echoes another number: `SchemaError`. The full number, S10 suffix
  included, must match.
- "Tracking Not Available" in `.latest-update-banner-wrapper .banner-header` (unknown or
  expired number): unlocated `unknown`. Only that wrapper counts; `.banner-header` is also
  used by an upsell banner and by the headings of the estimate's tooltips, which are skipped.
- The estimate comes from `.expected_delivery`, whose weekday, date, month and year sit in
  elements of their own ("Wednesday 28 October 2026 by 9:00pm"), and becomes
  `expected_delivery` as a calendar day. A delivered parcel has none.
- History comes from `.tb-step` cards (`.tb-status-detail`, `.tb-date`, `.tb-location`).
  Collapsed cards already hold the full history in the HTML. Undated placeholder steps and
  the "See All Tracking History" control are skipped. Rows of the older
  `.tracking_history_container` table are a fallback.

## Notes

- Detection names USPS for the parcels, EMS, registered and tracked-letter items it
  issues: `C`, `E`, `L` or `R` first, `US` last and a passing check digit. Its tracker
  follows them abroad, and USPS has no HTTP lookup, so recognition could not find it
  for them before a check. `CV` and `CE` codes are left out: Meest's tracker follows
  parcels from the United States under `CV` codes, and a CDEK Forward parcel from the
  United States was given a `CE` code. Other `US` codes stay with the unknown postal
  carrier, which makes USPS a candidate for opt-in browser recognition only. Other
  suffixes reach USPS when callers select it or through the delivery-partner handoff
  route.
- Scan times are facility-local. The state in the location maps to a zone (multi-zone states
  use their majority zone); a facility without a comma names its state before its kind, as in
  `EXAMPLE CITY NY DISTRIBUTION CENTER` or `EXAMPLE CITY PA PACKAGE SORTING CENTER`. A place
  that gives only a ZIP code is in that ZIP code's state, by its three-digit prefix. With no
  resolvable state the event keeps an offset-free `local_time`, and the page's newest-first
  order is kept rather than re-sorted. A step USPS dates by its day alone, as it does
  pre-shipment info, keeps that day as `local_time`.
- USPS enters some departures at their scheduled time, before they happen. A scan dated more
  than five minutes after the lookup is held back until it is due (`plannedScans`).
- Delivered lines are rewritten to "Delivered" because USPS names the signatory.
- Incoming international mail shows "Origin Post is Preparing Shipment", undated, from the
  origin post's electronic notice until USPS scans the item, past the origin post's later
  scans abroad and sometimes after the item arrives. While a scan is dated, the newest
  scan's wording is the status instead.
- USPS rewords scans it already shows: an out-for-delivery scan's delivery window changes,
  and the newest place-less step's "In Transit, Arriving On Time" reads "In Transit to Next
  Facility" once a later step comes. The identity policy lets such a scan take over the row
  stored in its earlier wording at its instant and place, and a place-less scan the row
  showing its wall clock under another deduced zone. A step reworded and re-zoned between
  two reads matches neither way.
- "Available for Pickup" and a hold at the post office are stage `ready_for_pickup` but result
  status `out_for_delivery`. "Arrived at Post Office" is the delivering office's arrival before
  the delivery round, so it stays `in_transit`.
- A parcel a shipping partner collects and moves reaches USPS with an acceptance scan such as
  "USPS in possession of item". After the partner's transit scans that handoff is
  `in_transit`, as is the parcel's stage; only an acceptance before any transit stays one.
- There is no direct step: it would only burn the budget on a 403.
- The package path is loaded directly because the legacy query route can return only
  the global header. A recognizable header-only reply, or the tracking page's head
  captured before its body, gets one more browser read within the same budget;
  telemetry retains the first failure. The bot check's blank interstitial, an untitled
  page holding only its script, which the browser can capture before the script reloads
  into the tracking page, gets up to two more: a second read stays on it about as often as
  a first one. A read redirected to the outage page gets one more. Other challenges,
  identity errors and rate limits are not repeated. Pasted legacy query links remain
  supported.

## Mobile API leads

The official [USPS Mobile APK](https://play.google.com/store/apps/details?id=com.usps.app)
opens `https://m.usps.com/m/TrackConfirmAction` in a WebView. Its native bridge
handles scanning and saved labels; it does not provide a separate tracking read.
The hosted destination returns a generic 404, which cannot establish parcel absence.

The newer [Informed Delivery APK](https://play.google.com/store/apps/details?id=com.usps.id45833)
contains the `https://apis.usps.com/tracking/v3` API base and native tracking models.
Its account token flow uses authorization codes with PKCE and the `tracking`
scope through `https://keyc.usps.com/realms/USPS-M/protocol/openid-connect/token`.
Obtaining the token requires user sign-in; the APK's client identifier is not an
access token. The tracking API rejects requests without a token with 401, which
does not establish how an authenticated tracking request behaves. This account
flow is not integrated into the adapter. Informed Delivery's household mail,
images and subscriber endpoints are outside this adapter's scope.

The separate [official developer API](https://github.com/USPS/api-examples/blob/main/README.md)
uses `client_credentials` at `https://apis.usps.com/oauth2/v3/token`, with a
registered application's Consumer Key and Consumer Secret and tracking access.
[USPS's access rules](https://www.usps.com/business/api-access.htm) give tracking data
free to a shipper for its own Mailer ID and to a platform a shipper authorizes. Anyone
else, such as a tracker for parcels it did not ship, needs paid access: a monthly fee, a
signed intellectual property agreement and authorization for the Mailer ID or the
tracking number. The [API terms](https://developers.usps.com/node/3) limit use to
facilitating USPS shipping or mailing transactions and set request limits USPS may
change. This is an option for consumers with that access; it cannot provide an
anonymous default. Developer authentication is not integrated into this adapter.

## Rejected approaches

- Plain HTTP to the tracking page, with or without cookies: 403 before any content.

## Limitations

- Browser access is intermittent: some sessions get only the challenge. That surfaces as
  `ChallengeError` so the router can fall back to universal providers.
- The public page shows city/state/ZIP only; no recipient, signature or photo is read.

## Testing

`npm run test:carriers:live -- carriers/usps` with
`USPS_LIVE_TRACKING_NUMBER` and `FLARESOLVERR_URL` set. The missing-browser check runs
without either.
