# Royal Mail

UK S10 and domestic 2D-reference parcel history through the public tracking application. Automatic
tracking uses a fresh browser context. `ROYAL_MAIL_BROWSER_WS_ENDPOINT` selects a private
Playwright browser service; otherwise `TRACKING_CHROMIUM_PATH` supplies local Chromium. The same tracker
answers for [Parcelforce](../parcelforce/README.md), whose numbers this adapter also accepts,
including its 14-character `PB` parcel numbers, and for mail from abroad, which keeps the
sending post's S10 number once it reaches the UK.

## Retrieval

The browser opens the homepage, allows functional cookies alone and follows
its tracking link. The site's consent manager files hCaptcha under functional
cookies and withholds its frame otherwise, and the tracking application sends
no request without a CAPTCHA token; a withheld frame ends the lookup at once.
Consent reloads the page, so number entry waits until it settles. The navigation link can be covered by the site's fixed header;
the adapter follows its validated destination in the same context.

The page obtains its own CAPTCHA token for the microsummary, then `Get more
details` uses the issued API session for history. When hCaptcha shows its
visible challenge instead, the page sends no request until a person solves
it. Without optional visual recovery, that context ends at once as a challenge. The application can refresh
an expired session itself. Tokens and cookies stay inside the browser. Opt-in browser recognition uses
the same lookup, requires dated activity and returns the history for reuse.
The carrier's launch settings and installed-version User-Agent are scoped to
this adapter.

Both replies must identify the requested `mailPieceId`. Missing or failed
details cannot become a history result; a valid empty events feed is marked
`summary_only`. Browser launch, queueing and retrieval share the caller's
deadline and cancellation signal, and the browser closes after each lookup.
A lookup takes at most 30 seconds of that deadline. An edge refusal or
interactive CAPTCHA can trigger one retry in a fresh context when at least
15 seconds remain. The retry requests the same history and records the first
challenge as its recovery reason. Rate limits, schema errors and confirmed
answers are not retried. An unavailable browser fails fast.

## Notes

- Summary categories and individual scan codes have separate meanings. The
  sender's despatch notice and a booked collection are registrations; a
  collection or a Post Office drop-off is the acceptance. Mail handed in at a
  parcel hub or a mail centre, or a collection one of them receives first, has
  none, so that first receipt is its acceptance, as the summary's "We've got
  it" says. A
  first receipt elsewhere keeps its in-transit stage, as the summary does.
  A category groups several scans: "Ready for Delivery" covers the delivery
  office's receipt and the day's round, and "We've got it" covers the
  acceptance and the mail centre's receipt after a Post Office, locker or
  postbox drop-off. When the summary repeats the newest scan and that scan's
  code places the parcel further along (the receipt after a drop-off, the
  round, customs), the code's stage stands. Receipts after a first receipt,
  the acceptance itself, stay under "We've got it".
- An item leaving a Customer Service Point ("Collected and Signed at",
  "Collected From Your Customer Service Point") gets no stage: these scans came
  just before a booked redelivery's round, and they could as well be the
  recipient's own collection. The same wording under the code the summary
  turns delivered with is the recipient's collection, and so the delivery.
- A delivery's scan time becomes `delivered_at`. The details reply's
  destination country becomes `destination_country`.
- Scan places lose the postcode Royal Mail appends to a Post Office branch,
  and a place given only as a postcode is dropped.
- A scan abroad names its country as, or after, the place. A European partner's
  scans carry its Central European wall clock under the UK's offset, even where the
  country keeps the UK's clock, as the destination post's own scans show, and so
  does an unplaced scan "in the destination country" bound for Europe; they are
  read on that clock, and the summary's copy of the newest scan follows. A
  partner's facility can go by its bare name: it is abroad when the wording puts
  it in the destination, or when it comes before the scan that leaves a European
  country of origin ("Item Leaving overseas"). A bare name shaped like Royal
  Mail's own facilities (`MC`, `DO`, `HWDC`) stays on the UK's clock. Beyond
  Europe, the label is the scan's instant, as at home: the South African post's
  own tracker gives a South African office's scans the same instants on its clock.
  Offset-free or invalid clocks remain in `provider_time_text`; sorting requires
  every event clock to resolve.
- The app identity policy in [identity.ts](identity.ts) lets a scan whose wall
  clock now carries another offset take over the row stored under the UK's
  label, and the reverse, by provider code and location, for Royal Mail's
  parcels and Parcelforce's alike.
- Markdown emphasis is removed from summary and scan wording. Delivered wording
  is reduced to `Delivered`. A scan that ends where the page shows its place ("Arrived
  at", "Due to be delivered today by") takes the place; without one, "at" names a Royal
  Mail office and "by" is dropped. The identity policy lets the reworded scan take over
  its stored row by instant and provider code. Recipient, signature, photo, address, GPS and
  issued credentials are discarded.
- Royal Mail's unable-to-confirm answer (E1142), its reply for a reference it cannot locate,
  remains inconclusive and carries `portal_not_found`: an item can be unknown until its first
  scan. Its answer that the reference's service is not tracked (E1283) is inconclusive too.
  Another HTTP 404 does not establish parcel absence.
- While the tracking application is down, its page answers 200 with a "Service temporarily
  unavailable" notice in place of the form. The lookup ends there at once as maintenance.

## Explicit browser-service calls

The dedicated WebSocket service runs the same tracking flow and parser as the local browser.
It takes precedence over local Chromium when `ROYAL_MAIL_BROWSER_WS_ENDPOINT` is set, including
for browser recognition. The browser's own platform sets its User-Agent. Queueing, connection
and retrieval share the lookup deadline; disconnecting disposes that lookup's contexts while
the supervised browser process stays available for the next call. Cookies and issued tokens
are not shared across lookups.

Run `parcel-scraper royal-mail-browser` on a host whose ordinary Chrome is accepted by the
tracking service. Set `TRACKING_CHROMIUM_PATH` to that browser, `ROYAL_MAIL_BROWSER_PORT` to
its local port, and `ROYAL_MAIL_BROWSER_WS_PATH` to a private random path of at least 32 URL-safe
characters after the slash. The worker binds to loopback. Carry it over an authenticated private
tunnel and configure the resulting endpoint on the caller. The client preserves the worker's
loopback Host header through the tunnel. Both ends need the same
`playwright-core` version. Keep the path and endpoint outside source control and logs.

The worker needs process supervision and an available host. If it is unavailable, tracking
fails as transport and enabled providers follow their normal fallback route. The local browser
remains available to installations without a dedicated endpoint.

`RoyalMailTracker` also retains the experimental TRAWL path when configured
with `trawl` and no local `executablePath`. It is excluded from
automatic routing. Constructor calls remain summary-only by default; pass
`fullHistory: true` for the separate events flow.

## Mobile API lead

The official [Royal Mail APK](https://play.google.com/store/apps/details?id=com.royalmail.app.droid)
contains the native request builders in .NET assemblies shipped in an ABI split.
Guest tracking uses `https://api-app.royalmail.com`, with
`/mailpieces/microsummary/v1/summary/{id}?returnExtendedData=true` and the separate
`/mailpieces/v3.1/{id}/events` read. Both request builders send an application
identifier, an issued anonymous bearer token and `X-acf-sensor-data` from the Akamai SDK.

The token request posts `grant_type: anonymous`, `scope: tracking` and `device_id`
to `/login/v1/tokens`. The standard host, `https://api.royalmail.net`, issues
anonymous tracking tokens with its own login application identifier. That token
does not unlock the protected tracking routes. The app uses a separate login
identifier on the protected host; requests with that identifier and the correct
body, but without SDK sensor data, receive an HTML 403. A token alone does not
establish a working HTTP-only tracking session. Application configuration and
tokens stay outside Git.

## Limitations

`ROYAL_MAIL_GEMINI_API_KEY` opts into single-drag hCaptcha recovery through Google
Gemini Flash-Lite. Only the cropped verification widget reaches Google. The adapter
writes no keys, images, answers or issued proof to files or logs. Recovery keeps the original
guest session and lookup deadline, after reserving the existing fresh-context retry,
with one visual round and no new attempt after a verification refusal.
Ambiguous plans, changed images, multi-page tasks, click tasks and unsupported layouts remain
challenges for provider fallback.

`ROYAL_MAIL_GEMINI_LOG_VERIFICATION=1` writes fixed verification labels, counts,
timing and a bound-history flag to stderr. Accepted verification without history
is not a recovered lookup. Explicit `RoyalMailTracker` instances can use
`captchaVision.onVerification` instead of logging. Neither interface includes
puzzle content, credentials or parcel identifiers.

Akamai or an interactive CAPTCHA can block anonymous retrieval. Browser build
and network affect access; enabled universal providers can handle a failed
direct lookup. The edge resetting the tracking request is reported as a
challenge, and it also refuses lookups that follow each other closely, so the
catalog asks for at most one refresh an hour. `ROYAL_MAIL_BROWSER_PROXY` sends
the browser's traffic through an `http://` or `socks5://` proxy when the edge
refuses the host's own address. Domestic 2D references have 21 characters (two hexadecimal, seven digits,
twelve hexadecimal) or 16 hexadecimal ones. They remain low-confidence candidates because their
shape can overlap unrelated identifiers. Printed spaces and hyphens are stripped
before submission. Other barcode formats and postcode-gated delivery options are
outside this adapter's scope.

## Testing

Set `ROYAL_MAIL_BROWSER_WS_ENDPOINT` or `TRACKING_CHROMIUM_PATH`, plus `ROYAL_MAIL_LIVE_TRACKING_NUMBER` and optionally
`ROYAL_MAIL_UNKNOWN_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/royal-mail`.
