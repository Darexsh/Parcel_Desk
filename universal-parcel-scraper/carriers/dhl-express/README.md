# DHL Express

DHL Express waybills through its mobile guest API, DHL's tracking API and public tracking
portal, separate from the German DHL Paket adapter.

Detection shares the [MyDHL+ tracking page](https://mydhl.express.dhl/gb/en/tracking.html)'s
waybill check with the adapter. A passing check prioritizes a candidate; it does
not confirm the carrier or the existence of a shipment.

An Express label's lower barcode, printed `(J)JD`, is DHL's piece identifier.
Detection gives its `JD01` range to DHL Express; DHL Paket's tracker answers
these numbers as another DHL service and sends them to DHL's global page. Only
`JD0146` pieces have been confirmed on live Express shipments. Other `JD01`
ranges appear on DHL's tracking pages but are no longer tracked; the rule covers
them by inference, as DHL Paket's plates use other prefixes. Typed with its
`(J)` before or after it, a piece of the `JD0146` range goes to DHL Express
too; DHL's tracker knows the piece only without it. Other `JJD` numbers stay
DHL Paket's licence plates, and the adapter reads any `JD01` piece with its
`(J)` on either side when DHL Express is named. A letter O typed for the zero after `JD`
(`JDO1…`) is read as that zero, since no carrier issues the shape with the letter.

Links to MyDHL+, to the Express tracking page on logistics.dhl and to
dhlexpress.pl, DHL Express Poland's site, name DHL Express. The logistics.dhl
page also takes DHL Paket's numbers: DHL's arrival scan links it with the
parcel's postal number when DHL Express delivers a DHL Paket parcel, as in
Italy, so the link names DHL Express only for an Express waybill or piece.
The adapter refuses other numbers without a request, so a hand-off never asks
it about another carrier's number.

## Retrieval

`direct` asks the mobile guest API for one waybill. Before it reads an empty
shipment list as a missing shipment, it checks the application's
waybill-encryption setting, so a configuration or authentication failure cannot
look like a missing shipment. A shipment found needs no setting, and every
adapter on the same transport keeps a confirmed setting for 15 minutes, so a
lookup, recognition included, usually sends the tracking request alone: DHL
turns its CAPTCHA on by the number of requests from an address. A tracking reply
other than a shipment list discards the setting; a request that got no reply
keeps it. The
shared application bearer is included; consumers need no DHL account or key
setup.

With `DHL_API_KEY` set, `api` asks DHL's
[Shipment Tracking Unified API](https://developer.dhl.com/api-reference/shipment-tracking)
under the consumer's own key when `direct` cannot answer: after a CAPTCHA, a rate limit, a
transport failure or an inconclusive reply, or while the mobile API rests. DHL's first level
gives a key 250 calls a day, so they go to the lookups that would otherwise need a browser,
and recognition never asks the API. Its reply is the global page's, with each event's offset,
and it resolves a piece identifier without a browser. DHL allows a key one call every five
seconds: calls through a key take turns, and a lookup whose turn would come more than ten
seconds later, or too late for its budget, skips the API with the reason `self_paced`. A rate limit pauses the key for
DHL's retry window, or an hour without one, and a refused key (HTTP 401 or 403) for an hour.
DHL's not-found ends the lookup there; any other failure leaves the number to `trawl`. DHL's
terms for the key bind the consumer: they ask for the line "Delivered by Deutsche Post DHL
Group" beside the data, its deletion 30 days after delivery, and no use with advertising.

When the HTTP steps meet a challenge or a transport failure, `trawl` loads DHL's global tracking
page in a fresh context and captures its matching `utapi` response. The browser
lets the page complete its verification and repeat tracking after an HTTP 428;
the intermediate challenge is not a shipment answer. HTTP recognition never
launches a browser; browser recognition is a separate opt-in phase and retains
its history.

A piece identifier goes to the tracking API and then the global page, because the
mobile API tracks waybills. Both resolve the piece to its shipment: the reply must
list the piece among the shipment's pieces and name an Express waybill, which
becomes `canonical_tracking_number`. Without the key or the browser service a piece
cannot be tracked, and HTTP recognition leaves it inconclusive.

The global portal's SEC-CPT flow runs its own JavaScript proof of work before
retrying `utapi`. Observe that exchange in the scoped browser helper before
changing headers or reproducing challenge code. MyDHL+ can instead return a
blocked HTML page with HTTP 200; that page contains no usable tracking history.

The tracking API's demo key and Try Now responses are mocked and cannot establish live
tracking coverage.

## Mobile API

The [official Android app](https://play.google.com/store/apps/details?id=com.dhl.exp.dhlmobile)
has package id `com.dhl.exp.dhlmobile`; DHL publishes its signing fingerprints in
[assetlinks.json](https://dhle.dhl.com/.well-known/assetlinks.json).
Its hybrid UI uses native pinned HTTP for tracking.

Guest tracking posts to `https://dhle.dhl.com/access/access/com.dhl.exp.dhlmobile`
with query parameters `appVersion` and `service=shipments-tracking`, and a JSON
body naming `service: "shipments"` and `method: "tracking"`. The data includes
`airWayBill`, `countryCode`, `languageCd`, `addShipmentToODD`, `moreDetails`, `iv`
and device metadata. Guest reads use empty user credentials but still require
the app's application bearer credential; missing application authentication
returns 401. The body includes an `authentication` object with provider
`DEMP.RS1` and empty `token` and `login` fields. `addShipmentToODD` stays disabled
so tracking does not save a shipment to an account.

The app reads `countrySettingsBySettingName` under the `common` service;
`api_awb_encryption` controls waybill encryption. The tracking flow also supports
`captchaVerificationData`. Returned shipments use `id` and `checkpoints`, with
localized `date`/`date_en` and `time` fields. Summary status can be empty despite
usable scans, so the adapter derives status from checkpoints ordered by their
counter and uses `date_en` for English facility-local clocks. An encryption
requirement or CAPTCHA stays a challenge and can recover through the browser.
The mobile API can report its CAPTCHA code inside HTTP 503; that explicit code
is verification evidence rather than a maintenance or missing-shipment answer.
A few tracking requests within minutes from one address draw that code for
every waybill and device for a while; the settings read keeps answering. A
server's address draws it like a home one and it lifts on its own: it is a rate
limit, not a block of the address.
The host can pin `dhle.dhl.com` to a separate egress through its supplied fetcher,
while keeping the browser endpoints on their own routes. That egress retains the
same request budget and cooldowns. After a rejection, no adapter instance in
the process that sends through the same fetcher asks the mobile API for half an
hour, and for twice as long each time the first request after a pause draws it
again, up to four hours; an answered request ends the doubling. A waybill
checked every ten minutes drew no code for hours, while twelve checks an hour
drew it within the hour, so a transport also sends at most six requests in an
hour, the settings read included. With the key or a browser service, lookups skip
`direct` during a pause or once the hour's requests are spent and go straight to
the next step, so only the request that drew the code records a challenge. Without
either, `direct` answers at once with the challenge, or with a rate limit whose
retry delay is when the next request may go; browser recognition still runs
after that rate limit. A restart forgets all of this, so a host that restarts
often asks again each time and can keep the code on.

Checkpoint stages come from [status.ts](status.ts). DHL's fixed sentences match
whole, and those that end with the facility ("Processed at CITY - COUNTRY")
match on their start. Other wording goes to the shared classifier.
"Clearance processing complete at …" puts the parcel back in transit; a
clearance still under way stays in customs. Only the stage changes, so stored
scans keep their identity.

## Limits

The returned identity must match the whole waybill and the browser response must
identify the Express division. Reused waybills and empty histories stay inconclusive.
The mobile API answers a missing waybill with an empty shipment list. A waybill it holds
records for but shows nothing about, such as one several shipments reuse, comes back as one
blank checkpoint: that is inconclusive (`portal_not_found`), and the global page is asked next.
A mobile scan carries its facility's clock and its location, without an offset. The
location reads `CITY - COUNTRY`, or `CITY - REGION - COUNTRY` in the USA, Canada and
Australia, where the region is a state's or province's name or code, or for an Australian
state its first four letters (`VICT`). [clock.ts](clock.ts) reads the clock in the country's
zone when the country keeps one civil time, and in the majority zone of the state or
province, so a facility in its other zone is an hour off. An Australian gateway without a
region is placed when DHL names it after a state's capital. Spain and Portugal file
their islands under the country: a town or island of the Canary Islands or the Azores takes
the islands' clock, unless the mainland has a town of that name. Ship24 relays the same
scans with DHL's own offsets, and the rule agrees with them on every scan of the public
samples.

Some records are not on the facility's clock: customs status updates (also written in UTC,
or an hour off in Switzerland) and the shipment's data (on the clock of the system that
entered it). The global portal gives them their own offsets; the mobile API gives only the
wall clock, read on the facility's zone, so they can be off by the difference. The app
identity policy in [identity.ts](identity.ts) (`matchWallClock`) lets a record from one feed
take over the row the other stored, by wall clock, location and wording, so the parcel keeps
one row.

DHL Express enters some processing scans at their planned time, before they happen. A scan
dated more than five minutes after the lookup is held back until it is due (`plannedScans`).

A scan whose location settles no zone keeps its clock as `local_time`: a country with
several clocks and no region, or a country DHL writes in a form the rule does not know.
The rule knows English country names, the forms on DHL's scans (`UK`, `USA`, `NETHERLANDS,
THE`, `THE PEOPLE'S REPUBLIC OF CHINA`) and those of DHL's country list. DHL has renamed a
country on its scans before, so a scan can meet a form the rule has yet to learn. The global
portal's explicit offsets provide dated instants. Recipient details, piece identifiers and
proof-of-delivery links are discarded. A blocked HTTP request requires a configured
browser service with the DHL Express capture helper.

## Testing

`npm run test:carriers:live -- carriers/dhl-express`

Set `DHL_EXPRESS_LIVE_TRACKING_NUMBER` to exercise mobile retrieval. Add `DHL_API_KEY`
to exercise the tracking API, and `TRAWL_URL` to exercise the separate browser path.
Carrier protection can reject HTTP and browser sessions. These failures stay
distinct from a missing waybill.
