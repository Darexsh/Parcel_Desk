# 17TRACK

Browser-only universal provider. It splits multi-operator journeys into per-leg
histories, often including the destination postal operator, and reports carrier names.
It runs after Ship24 and ParcelsApp, except for checksum-valid China Post `C…CN` and
`L…CN` numbers, which start with it (reason in [COMPARISON.md](../COMPARISON.md)).
Persisted provider name: `17TRACK`. The folder is `seventeentrack` because an import
path cannot start with a digit. Link shown to users:
`https://t.17track.net/en#nums={number}` (it follows the app language).

## How it works

One step, `trawl`, with a 30 s budget:

1. TRAWL (`FLARESOLVERR_URL`) loads the tracking page (`skipHttp`, up to tier 3) and
   captures `https://t.17track.net/track/restapi` replies with a 15 s settle window.
2. A matching empty reply that asks for a postcode becomes `InputRequiredError`.
   When supplied, TRAWL skips the optional demo tour and submits the site's postcode
   form. Its normal handler signs the request and retains the detected carriers.
   Captures mark whether that exact request included the postcode; an older browser
   service that ignores it returns a transport error instead of claiming a retry.
3. Bodies are parsed newest first. Shipment code 100 means 17TRACK is still polling, so
   the loop continues and remembers the last typed failure.
4. A completed, identity-matched `NotFound` with no rows becomes `NotFoundError`.
5. If nothing parses, the last typed lookup failure is thrown, so a verification wall
   is never reported as an empty capture. Without one, the error says what happened:
   `capture_missing` (nothing captured), `capture_unreadable` (unreadable body) or
   `history_missing` (replies without history). These are indeterminate and say nothing
   about the shipment.
6. 17TRACK picks the carrier from the number, and for some carriers it picks another one
   (GLS France's numbers read as GLS's group service, which shows one scan, DPD Poland's
   as DPD Germany) or none. When the parcel's carrier (`TrackingInput.carrier`) is listed
   in [carriers.ts](carriers.ts) and the first answer has no history, is still polling when
   the page settles, or has none from that carrier, the page is loaded again with 17TRACK's
   key for it (`&fc={key}`), as a visitor picks a carrier on the page. That answer is kept when it has at least as many dated
   scans; otherwise the first one stands. It needs 5 s of the budget left.

This needs the pinned TRAWL compatibility build ([ops/trawl](../../trawl/README.md)).
TRAWL 1.3.1 ignores capture requests. Stock 1.9.3 refuses compressed bodies and can
finish before polling completes. The compatibility build captures the browser-decoded
JSON and waits through code 100.

A cached page can come back as HTTP 304 and still carry a fresh API reply.
[shared/capture.ts](../shared/capture.ts) accepts 304 for capture flows and validates the
captured bodies instead.

## Provider codes

Swiss Post's exact vehicle-loading label refines 17TRACK's generic transit bucket into
out-for-delivery, and its "Registered", the sender's data before Swiss Post has the item,
into registered. Other operators' "Registered" can be an acceptance, so it stays with the
shared rules. The reported provider code is preserved.

Codes -11, -13 and -14 mean interactive verification. Shipment code 100 means polling.
A matching code-400/null-shipment reply means no history, unless its parameter metadata
requires a postcode the caller has not supplied. The metadata is the form of the carrier
17TRACK picked, so a form that also requires another field is no postcode prompt: for
PostNL, 17TRACK requires a destination country (its pattern rejects an empty value) beside
an optional postcode, and a postcode alone cannot complete it. An optional postcode is no
prompt either: the four the benchmark met (DPD France, GEODIS, and The Courier Guy numbers
17TRACK took for GLS) were parcels no source had, and 17TRACK returns those carriers'
history without a postcode when it has it. Modern `params_v2` takes
precedence over legacy `param` and `params`. Optional postcode metadata never suppresses
usable history.
A completed postcode submission that still has no history stays `no_history` rather
than asking again. A code-400 reply can list the carriers 17TRACK hesitates between
(`extra[].multi`); it is still no history. Other non-200 codes, including envelope-level
400, mean lookup unavailable.

Shipment code 402 is 17TRACK's monthly cap on USPS lookups ("USPS tracking requests are
limited due to policy changes"), and the page offers a paid plan. Once the browser
service's address has spent it, every USPS number answers 402, while a fresh address still
gets history. It is inconclusive (`IndeterminateError`, reason `usps_quota`), not lookup
unavailable: it says nothing about the shipment, and other carriers are not capped, so a
host that cooled 17TRACK down for a transport failure would lose it for every carrier.

Routing needs these distinctions for its cooldowns. Sentry keeps `reason`,
`providerCode` and `meta.message` (truncated to 120 characters), because code 400 is
intermittent. A no-history reply proves neither an invalid number nor an unsupported
carrier.

## Parsing

- Exactly one shipment must match the requested number. Demo numbers and ambiguous
  replies are rejected.
- Stages come from the exact `sub_status` map in [status.ts](status.ts) first. It works
  when `stage` is null or the description is Chinese, and a stage it gives is credited to
  the map (`carrier_map`). Then come the declared stage and the shared wording rules. `Exception_Returning` is not a completed return.
  `InfoReceived` yields to Correios Brazil's posting ("Objeto postado") and its export unit abroad receiving
  the item, scans 17TRACK files under it.
  Shipment-level `Expired` is never a scan and never means lost.
- Times: `time_utc`, else `time_iso`, and both must carry an offset. When both parse but name
  different instants, `time_iso`, the clock and offset 17TRACK shows, wins: on India Post's legs
  `time_utc` lands 30 minutes after it. Rows with neither are dropped and counted in
  `undated_event_count`, and so are rows whose `time_raw` has no date: 17TRACK can fill their
  `time_iso` with a placeholder such as `01.01.2000, 00:00` (DPD Germany's rows for a parcel
  from abroad). A malformed non-empty timestamp is a schema error. Retrieval time is never
  used as a scan time. A row the carrier dates by its day alone keeps that day as `local_time`,
  with no time: one whose `time_raw` has a date and no time, which 17TRACK still shows at
  midnight, and the sender's information (`InfoReceived`) at exactly midnight, as Swiss Post's
  "Creation date" and GLS Italy's "created by the sender" come.
- 17TRACK sometimes adds the offset itself (`time_raw.timezone` is null), and it can be
  wrong: for one parcel, the China Post leg put `+08:00` on the same wall clock that
  USPS reported at `-07:00`. Each event keeps `provider_time_iso`, `time_provenance`
  (`provider_inferred`, `carrier_reported` or `unspecified`) and the reporting carrier's
  name and key. The timeline still uses 17TRACK's reading, and mirrored scans from two
  operators are not deduplicated. That is why a scoped China Post success skips
  timestamp-based shadow comparisons.
- Where it adds the offset, 17TRACK uses its zone for the carrier at that zone's offset on the
  day it looks, not on the scan's: after October's change it put `+01:00` on BRT's July scans
  and on DPD Germany's and Correos Spain's September scans, which it had labelled `+02:00` in
  summer. A row no rule below reads, labelled with its zone's offset at lookup time while the
  scan's own date keeps another, is read on that zone's clock at its own date. The zone is the
  leg's country's when that keeps one clock, and Central European time for GLS (carrier key
  100005), whose leg names Great Britain. Any other label stays.
- DHL Express scans carry the facility's clock in `time_raw`, and 17TRACK puts one offset
  on all of them, so a scan in Shenzhen gets the destination's. They take the zone the
  [DHL Express rule](../../carriers/dhl-express/clock.ts) reads from their location
  instead. A scan the rule cannot place is counted in `undated_event_count`, and when it
  is the reply's latest scan the reply is inconclusive.
- USPS's leg (carrier key 21051) shows USPS's wall clocks, each the scanning facility's.
  A row given to the second can name USPS's zone in `time_raw`, and keeps it. On a row
  without a zone, 17TRACK puts an offset it guesses from the scan's state: right in Arizona, but
  `-05:00` in Indiana, which keeps Eastern time, an hour late against USPS's own page. A row
  whose place names its state or gives a ZIP code is read in that state's zone, as the
  [USPS adapter](../../carriers/usps/README.md) reads it. A row with no place, or with the
  country alone, gives no state: it keeps USPS's wall clock as `local_time`, as the USPS
  adapter gives it, so a consumer dates both copies alike. A place that names neither keeps 17TRACK's reading.
  A step USPS dates by its day alone, such as a label printed at a post office, comes at
  midnight under 17TRACK's offset; it keeps its day as `local_time`, as on USPS's page. A
  USPS scan at exactly midnight is read the same way.
- BRT's leg (carrier key 199997) shows its "FOR DELIVERY" round, which BRT's page dates by
  its day alone, at midnight; it keeps its day as `local_time`, as the ParcelsApp copy does.
- Correos de Chile's leg (carrier key 3101) shows its wall clocks, and 17TRACK labels them
  `-04:00`, Chile's offset outside summer time, in summer too: an hour late against
  Correos de Chile's page and Correios Brazil's copies. That leg's `time_raw` is read on
  Santiago's clock, unless its place names a country on one clock.
- Asendia USA (carrier key 100016) relays A1's tracking, which dates every scan in UTC,
  partners' scans too, and 17TRACK labels those digits with US Eastern time. A Swiss Post
  scan at 18:20 `+02:00` is A1's 16:20, which 17TRACK showed as 16:20 `-04:00` (checked
  2026-10-10). That leg's `time_raw` is read as UTC.
- Shiprocket's leg (carrier key 100662) shows its rows' wall clocks, India's for the hubs in
  India, and 17TRACK labels them with US Eastern time, nine and a half hours late against
  Shiprocket's own page. A row placed in an Indian state is read on India's clock, as the
  [Shiprocket adapter](../../carriers/shiprocket/README.md) reads it; any other keeps its wall
  clock in `local_time`.
- Huiyi Logistics' leg (carrier key 192109) keeps the `+00:00` of the line's rows, whose
  digits are wall clocks ([Huiyi Logistics](../../carriers/hywl/README.md)). Read as labeled,
  most of its rows in China fall between midnight and 06:00 there, and on Beijing's clock all
  in the day. A row placed in China or Hong Kong is read on Beijing's clock; any other keeps
  its wall clock in `local_time`, as the line's own rows keep it.
- DAI Post's leg (carrier key 100790) shows the tracker's clocks, each the scan's local time,
  and 17TRACK puts one offset on all of them: `+01:00` on a parcel from London, on its
  Singapore and Brisbane scans too. A scan is read as the
  [DAI Post adapter](../../carriers/dai-post/README.md) reads it, in its country's zone where
  that keeps one clock. A scan in Australia or the US, or the label data, is counted in
  `undated_event_count`, and when it is the reply's latest scan the reply is inconclusive.
- CTT's leg (carrier key 16101) shows CTT's wall clocks with Portugal's offset. A row is read
  on the clock its place names, as the [CTT adapter](../../carriers/ctt/README.md) reads it: a
  CTT Express agency's scan in Spain, and the acceptance with no place up to a minute before
  it, on Madrid's clock.
- Quick Rabbit's leg (carrier key 101309) shows the clocks Quick Rabbit's page shows, and
  17TRACK labels them `-04:00`. Its rows are read on Madrid's clock, as the
  [Quick Rabbit adapter](../../carriers/quick-rabbit/README.md) reads them.
- NZ Post's leg (carrier key 14061) shows NZ Post's wall clocks, and 17TRACK labels them
  with New Zealand's offset on the day it looks: in October it put `+13:00` on August
  scans, when New Zealand kept `+12:00` (checked 2026-10-10). That leg's `time_raw` is read
  on Auckland's clock at the scan's own date. On an item NZ Post sends abroad (an S10
  number ending `NZ`), a scan after the international departure, but an airline's, shows
  the clock where it happened ([NZ Post](../../carriers/nz-post/README.md)). The leg seldom
  names a place, so such a scan borrows a country, a guess: the one its own location names,
  else that of the nearest earlier scan after the departure that names one (an airline's
  included), else the nearest later one's, else the destination the reply names: the
  recipient's country, or the country of the one other post whose leg it carries (China
  Post's `CN`). The guess can be a transit hub's country, but Hong Kong, Singapore and China
  all keep `+08:00`. When that country has several clocks, the scan stays a wall time
  (`local_time`). When nothing names a country, NZ Post's Auckland reading stays, the last
  guess: hours off, but a delivery keeps its instant. The reply stays conclusive.
- Poland Post's leg (carrier key 16081) shows Poczta Polska's wall clocks, and 17TRACK labels
  them with Poland's offset on the day it looks: after October's change it put `+01:00` on
  July scans, when Poland kept `+02:00`. That leg's `time_raw` is read on Warsaw's clock at
  the scan's own date. A scan after the departure from Poland is a partner post's, on its own
  clock: it is read in the recipient country's zone when the reply names one on a single
  clock, as [Poczta Polska](../../carriers/poczta-polska/README.md)'s adapter reads it, and
  otherwise keeps 17TRACK's reading.
- FedEx International Connect's leg (carrier key 100222) shows FIC's own scans at its British
  hubs and, from `RECEIVED BY PARTNER CARRIER` on, the scans of the carrier that delivers in the
  recipient's country, without a place and on that carrier's clock. 17TRACK labels them all with
  London's offset, so a Dutch post's scans came an hour after the post's own times. A row from the
  handover on that is not placed in Britain is read in the recipient country's zone when 17TRACK
  names a country on one clock, and otherwise keeps 17TRACK's reading.
- China Post's leg mirrors the origin post's outward exchange scans (`到达境外出口互换局`,
  `离开境外出口互换局`) on that post's wall clock, and 17TRACK labels them `+08:00`: an NZ
  Post arrival at 06:09 Auckland time showed four hours late (checked 2026-10-10). On an
  S10 number from a country on one clock, or from New Zealand (Auckland's), they are read on
  that clock. Elsewhere, and for its handover scans (`已送交承运商`), whose clock is unknown,
  17TRACK's reading stays.
- Correos de El Salvador's leg (carrier key 19031) dates its own scans in UTC, as its own
  tracker does, and its copies of the origin post's scans, marked `(salida)` or
  `(recibido por EDI)`, at the origin office's wall clock; 17TRACK labels them all `-05:00`
  (checked 2026-10-11). Its own scans are read as UTC, its copies on the clock of the
  country an S10 number ends with. From a country with several clocks, 17TRACK's reading
  stays, the last guess.
- Correos Spain's leg (carrier key 19181) shows Correos's wall clocks, worded "PHASE,
  summary, details", with Madrid's offset. Its copies of an origin post's scans, told by
  Correos's summaries "En oficina de cambio" and "En aduana de origen", are at that post's
  clock, as on Correos's own tracker ([Correos](../../carriers/correos-spain/README.md)):
  they are read on the clock of the country an S10 number ends with, or stay wall times
  when it has several.
- Swiss Post's leg (carrier key 19251) relays the destination post's arrival, customs,
  sorting and delivery scans, with no location, at that office's clock under Swiss Post's
  offset ([Swiss Post](../../carriers/swiss-post/README.md)). They are read on the clock of
  the recipient's country (`shipping_info`) when it keeps one; else 17TRACK's reading stays.
- India Post dates a take-off with the departure airport's wall clock labelled UTC, and
  17TRACK keeps the label: a Mumbai take-off showed 5.5 hours late, a Frankfurt one 2 hours
  late. India Post rows worded `Aircraft Departure` or `UPLIFT` are counted in
  `undated_event_count` instead of dated. The scans before one still describe the parcel,
  so the reply stays conclusive. India Post's own adapter places take-offs.
- DHL eCommerce US's leg (carrier key 7047) adds an `EN ROUTE` row without a place each time
  17TRACK asks Webtrack again, stamped with that moment. It echoes the status, so it is left
  out, as [DHL eCommerce's adapter](../../carriers/dhl-ecommerce/README.md) leaves it out.
- Original scan text is kept: the English interface does not translate descriptions. China
  Post's leg, and JHGJ's, which relays China Post's labels, show a label in the English the
  [China Post adapter](../../carriers/china-post/README.md) shows, its places left to the location,
  and a copy stored in Chinese takes the English in place. A label that names its place only in 【】
  ("启运【Example】") with no location gives it that place; a partner's scan abroad gives its
  country's code there before its English cut short ("【ZZ Arriyal at Processin】"), and that
  code is its place. Pengyou's leg writes its place in
  brackets after its English wording ("Airline received【Example】"); with no location, that place
  becomes the location, and a copy stored with the brackets takes the new form in place.
- Each scan keeps the `location` 17TRACK reports, unless it holds private delivery details or
  is Posti's "ULKOMAILLA" ("abroad") or the "目的国" ("destination country") China Post's feed
  gives an airline's arrival in place of a country's code: neither names a place. China
  Post's feed can also give the scan's status there, at times with the place after it in 【】
  ("Departure from【Example】") or before its airport ("Arrival at Example Airport"); the scan
  keeps only that place, without a full Canadian or British postcode, or none. A town loses the
  eight-digit code of the China Post office that follows it, and a copy stored with the code
  takes the new form in place. JCEX's places come with the row's offset after them: a US town
  as "TOWN;ST;POSTCODE;-07:00", kept as the town and state, or the destination JCEX files the
  row under, "US+08:00", which names no place under an offset the country never keeps (JCEX's
  rows in China). A US town can also come as "TOWN,ST,US,POSTCODE", kept without the postcode.
  JCEX's "The carrier" names none either.
- At most 20 carrier legs and 1000 events. Per-event `address` is never read, and of
  `shipping_info` only the recipient's country, for an NZ Post, Poland Post or Swiss Post leg: the
  address can be the recipient's street.

## Rejected approaches

- Unsigned direct POST: returns HTTP 200 with rejection code `-14` (current endpoint) or
  `-10` (legacy endpoint). Embed-style widget requests get `-14` too.
- The 2019 anonymous endpoint (`kamushadenes/tracker17`): superseded.
- Account-based clients (`mderazon/seventeen-track-js`): need sign-in.
- API-key integrations (official API, `TA2k/ioBroker.parcel`): need a provisioned key.
- A separate widget integration: ChinaPostalTracking's tracker is 17TRACK's public widget
  on the same `track/restapi` endpoint. The normal page route already works.
- Making 17TRACK first for everything: a browser lookup costs seconds, while Ship24's
  direct HTTP usually answers in under a second.

## Testing

No dedicated live test. `npm run test:carriers:live -- testing/expandedCarriers.live.test.ts`
with `FLARESOLVERR_URL` set runs the whole chain, which can end at 17TRACK. Unit tests use
synthetic [fixtures](fixtures/README.md).
