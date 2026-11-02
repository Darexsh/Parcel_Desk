# Optional TRAWL browser service

Some carriers and universal providers only answer a full browser session. This image extends
[TRAWL](https://github.com/germondai/trawl) with identity-bound capture for DHL Express, FedEx, UPS, USPS, Royal Mail,
Australia Post, YunExpress, 17TRACK, SF Express, WanbExpress, XPO, Asendia, Correios Brazil, DHL Poland, Magyar Posta, Poste Italiane, SwiftX, China Post, JD Logistics, Ozon and ZTO. The adapter checks the captured response against
the requested parcel. A solved challenge alone is not tracking history.

Pro Carrier, Delnext, MRL Global, AIT Worldwide, Hitch, PBT and Celeritas also use the
ordinary browser tiers after a challenged HTTP lookup. Their adapters read the rendered
page through the same identity checks as HTTP; no carrier helper or image rebuild is needed.
Trendyol Express uses those tiers for its public shipment page and reads the complete
collapsed timeline without recipient details or delivery controls.

Ozon's helper waits for its guest form after browser verification, then reads the matching
posting API through a bounded decoded stream. It returns the full timeline without retaining
cookies or the rendered page. Ozon Rocket references are outside that helper's scope.

USPS also captures its tracking request's redirect to the official outage page.
That redirect can leave the verification wrapper blank; retaining it lets the
adapter distinguish temporary unavailability from an unresolved challenge.

Spee-Dee also uses the service's HTTP tier after a refused direct connection; the benefit
is the service's network, and no browser is launched. MTCaptcha (Hongkong Post)
needs handling that this image's solvers do not provide; its
[documentation](../carriers/hongkong-post/README.md) describes the verification flow.

Track123 uses a fresh context for its public FedEx form. The page owns guest verification and polling; only the matching history is captured. It adds no challenge attempts or retained verification state.

## Sessions

The service reuses browser sessions, never parcel responses. FedEx keeps one verified context
per pooled browser and discards it on expiry, mismatch or failure. TRAWL's named sessions do not
replace it: FedEx's API refuses the tracking call a kept session page makes for a tracking URL,
and the untrusted input of a session eval never sends one. Australia Post,
DHL Express, SF Express, WanbExpress, XPO, Asendia, Correios Brazil, DHL Poland, Magyar Posta and ZTO use fresh contexts.
SF Express solves GeeTest's slider locally and asks for at most two other puzzles when it
cannot read one.
ZTO solves Dingxiang's slider and ordered-character challenge locally, with at most two
concurrent offline OCR workers; a request waits for a free worker within its deadline. Each
worker ends with its request and retains no images. A puzzle the helper cannot read is
swapped for another through Dingxiang's refresh control, at most twice per lookup.
The `zto.verification` warning records how each run ended. For each puzzle it gives the
kind, the slider's match score or the OCR's confidence, boxes and time, and whether
Dingxiang accepted, refused or escalated the answer to secondary verification.
Puzzle readiness, analysis, input and verification have separate timings. Each verdict
stays bound to its submitting request, and an unfinished later challenge keeps its timeout.
Fading puzzles wait until visible, and coordinates are discarded if the puzzle changes
during analysis. The warning has no images, answers, tokens or tracking numbers, and
the adapter reports the same outcome as its challenge reason.
Verification failures and the public tracker's incomplete history still need enabled providers.
SwiftX emits a `swiftx.verification` warning for an observed image challenge or
an unresolved prepared page, using fixed puzzle types, outcome labels and counts.
Analysis labels distinguish worker limits from an uncertain image match.
It retains no images, answers, tracking identifiers or verification tokens.
China Post reads its ordered-character prompt offline and takes click positions from the
shared character worker; a worker failure stays unreadable. It submits the anonymous preview form
and can refresh a completed but unreadable prompt once through the official widget,
within the same two-puzzle limit and deadline. Worker errors, cancellation and timeouts
do not trigger that refresh. The replacement must have a new identifier and background,
and its image must be displayed before solving it. A `china-post.prompt-refresh` warning
records the recovery's bound scan count without puzzle content. The helper
retains only scan state labels and local clocks. If the entry form fails to load,
it reloads the official page once before sending any tracking request. An identified
unsolved verification on an HTTP 200 page reaches the adapter as a challenge,
with its phase retained in a `china-post.verification` warning.
The `china-post.form-reload` warning records whether the form recovered and
a bound scan reply arrived, without identifiers or page content. Its two-scan guest window stays marked
incomplete; the helper enters no phone digits and signs into no account.
JD's domestic single-icon helper segments the opaque prompt and requires shape
and colour to match in the same rotated pose, with a margin over other locations.
It declines ambiguous images and layouts outside its supported geometry, and its
`jd.verification` line names which (`geometry`, `image`, `foreground`, `matching` or
`ambiguous`). Its worker has a deadline and concurrency limit; click geometry binds both
displayed images.
Its official page retains the original guest session and submits tracking only after
accepted verification. The helper makes one puzzle attempt; abstention closes the context
without a click, refresh or tracking request. Both the request and response bind the whole
waybill. A planned click alone is not accepted verification.
DHL Poland uses TRAWL's native checkbox and audio solver.
Poste Italiane uses that solver only after its tracking API requests a CAPTCHA. Its page
submits the issued token and the helper captures the matching history, keeping the earlier
refusal and excluding verification tokens and recipient fields. A disappearing widget does
not override a tracking request already in flight: its response and body finish within the
same deadline. Failed or unfinished later requests stay failures. While the audio pause below
is on, the helper does not open the page: the adapter asks it only after a direct search drew
the CAPTCHA from the same address, so the page would show it again. The fixed-label
`poste.verification` log records native solver outcomes and pending-request counts without
tokens, parcel identifiers or page text.
Its scoped native modules replace upstream raw debug logs with fixed events.
It submits its history form after reCAPTCHA verification and returns only
the waybill and scan fields, excluding recipient acknowledgements and verification tokens.
Asendia waits for its own Turnstile callback to enable search and binds the captured POST
to one whole identifier. Given a delivery postcode in the fragment, it opens the scans through the page's dialog; otherwise recipient verification leaves the current status only.
Correios Brazil opens its tracker's share link, waits for the page's Turnstile token and searches through
the form, keeping the reply whose POST carried the whole S10 number without locker codes, receipts or
recipient fields. Its `correios.verification` warning counts token receipt, submission and bound
responses with HTTP statuses, without identifiers, tokens or page content. XPO scopes the checkbox
solver to its visible widget while the public client completes verification and tracking.
Magyar Posta renders the Posta app's invisible reCAPTCHA Enterprise widget on the app's WebView
origin, answers its audio challenge with TRAWL's speech-to-text and posts one number to the app's
guest list, keeping the reply without names, phone numbers or the token. Its fallback opens the
tracker the public page frames, solves the checkbox there, searches one number and keeps the
result page its search redirects to, without scripts or form tokens.
DHL Express waits for the public
page to complete verification and repeat tracking after an intermediate HTTP 428.
17TRACK submits a supplied postcode through the site's form and binds the capture to
the number and postcode in its outgoing request.
UPS binds the browser POST to one tracking ID and retains the latest bounded
response sequence, including refusals after the body extraction budget is spent.
SwiftX's page clears Cloudflare's managed challenge and offers a slider when Turnstile
cannot complete. Its scoped helper matches cutouts, image seams, circular rotations and
ordered icons offline, rejecting ambiguous matches. It uses the page's pointer handlers,
with at most two puzzles; verification tokens stay in that context.
The page then posts one GraphQL query; the helper keeps
the decoded reply only for the query naming the whole number in the page's address.

Redis is optional. It stores cookies, user agents and the audio pause deadline with a TTL, not tracking history, and a
cached session that fails falls back to a fresh browser. Do not expose Redis.
Keeping a browser session does not make an application CAPTCHA token reusable;
the site can require fresh verification for each action.

## Run it

```sh
docker build -t universal-parcel-scraper-trawl trawl
```

A host that keeps a Dockerfile without its build context, such as Coolify, takes the output of
`node trawl/render-coolify.mjs` instead: the same image with its sources embedded. It labels
the image `org.opencontainers.image.revision` with the commit it was rendered from, followed by
`-dirty` when the sources differ from that commit.

Keep the service on a private network. Pass its URL as `trawlUrl` to the library, or as
`FLARESOLVERR_URL` to the CLI and the HTTP server. `TRACKING_CHROMIUM_PATH` enables the
separate local Chromium transport.

`REDIS_URL` configures the session cache. `AUSTRALIA_POST_BROWSER_LOCALE` overrides the
browser locale for Australia Post, and `FFMPEG_PATH` selects SF Express's PNG decoder.

`BROWSER_SHUTDOWN_DRAIN_MS` lets accepted lookups finish when the container stops; by default
TRAWL interrupts them. It exits by force 30 seconds after the drain, so give the container a
stop timeout of the drain plus 30 seconds, or the supervisor kills it mid-drain. `GET /metrics`
reports the browser pool to Prometheus.

The image sets `LOG_LEVEL=warn`. TRAWL's request log includes the page path, where some
carriers put the parcel number; `LOG_LEVEL=info` turns that log on. Each tier that fails, is
blocked or times out logs a `tier.failure` warning with the page's host, its status, the page's HTTP status and
the error it caught: the error's name and the first line of its message, up to 200 characters,
without URLs or query strings and with runs that could be identifiers masked.
FedEx's captured API refusals leave the browser tier successful. A separate
`fedex.api-refusal` warning records the API status, browser slot, session reuse,
session age, time since the browser's previous lookup and verified lookup, and
lookup count on that browser. It contains no parcel identifier, response body or cookie. The
`fedex.session-end` warning records why a context closes, its age and lookup count,
and whether it ever returned verified tracking. It distinguishes expiry and browser
loss from an unreadable or inconclusive reply, without identifiers or response content.

TRAWL drops a reply that reaches its request deadline. The image ends its own waits and
TRAWL's CAPTCHA solvers 2.5 seconds before it, so a page behind an unsolved widget and
the replies already captured are still returned.

TRAWL's reCAPTCHA audio solver stops as soon as Google's challenge frame shows its
automated-traffic page or refuses an answer. It reads both from the frame's class names, so a
widget in any language counts. An automated-traffic page also pauses audio for six hours
across the service's solver copies, Poste Italiane and DHL Poland helpers. Skipped lookups
do not extend the pause; a wrong transcription does not start it. Except on Poste Italiane's
page, which is not opened, clear tracking replies and forms already verified by the page still
work, while unresolved challenges stay available
to enabled provider fallback. With `REDIS_URL`, the pause survives service restarts and rollouts
in the existing Redis store. It keeps only the deadline, shared across solver copies and concurrent
service processes. Without Redis, or while it is unavailable, the pause stays in process memory;
an unavailable store logs a fixed warning. Each store operation is bounded to a quarter second.

## Tests

`npm run test:scripts` runs the offline capture and session tests. Live adapter tests need a
running browser service and references supplied through the environment. Browser challenges
and upstream limits can still prevent retrieval.

## Upstream releases

A nightly workflow builds this image on each new TRAWL release and reports in an issue
whether the patches still apply. `node scripts/trawl-upstream.mjs --write` moves the pins
to that release. Compare the service's answers with the pinned release before deploying:
a build does not show a changed deadline or a field missing from a reply.

## License

This derivative is [AGPL-3.0](LICENSE), separate from the core package's Apache license.
[Matching source and redistribution](SOURCE.md).

Track718 has a Juxi-only helper for its guest detail page. It binds the selected Juxi carrier,
complete number, signed tracking request and WebSocket session, retaining the completed replies
without account or recipient fields. Other Track718 carrier selections use no helper.

## Independent FedEx IPv6 worker

Run `bun /app/packages/tiers/src/utils/fedex-ipv6-server.mjs` from this same image
in a separate container with its own browser pool. `HOST` defaults to loopback;
`PORT` defaults to 8192. Keep its endpoint private and set `LOG_LEVEL=warn`.
It serves only the exact FedEx capture flow, one lookup at a time, with no shared
browser profile or session cache. Keep the primary service's deployment settings.

A per-context loopback CONNECT proxy resolves the FedEx page and tracking API
with IPv6 only, connects to a validated public address, and verifies the socket
family. It preserves public HTTPS page dependencies, including IPv4-only resources.
Missing IPv6 never falls back to IPv4 for the page or API. DNS answers, URLs and
cookies are not logged; the response reports aggregate connection proof. The
worker returns no rendered page or cookies. Failed contexts and their proxies
are closed together. Use `FEDEX_IPV6_TRAWL_URL` in the consumer and compare retry
outcomes against the original route with `FEDEX_IPV6_RETRY_PERCENT`.
