# Postal Ninja

Opt-in universal provider: selecting `Postal Ninja` in `providers` (`SCRAPER_PROVIDERS` for
the CLI and server) asks it after the other aggregators, whatever its rank in the coverage
evidence, because many of its international histories have no scan a consumer can place. Its lookups
take a browser session and rarely find a named carrier's parcel the others missed, so it is
asked about a carrier only when that carrier's [coverage evidence](../COVERAGE.md) shows its
history. A number no carrier is named for is where it most often has the only history, so it
is asked about every such number.
Through TRAWL it returns full histories, often with destination legs. Its scan times
have no zone: scans of a service whose clock is established are placed on it, and others
borrow a zone as a guess (see [Parsing](#parsing)). Persisted provider name: `Postal Ninja`. The results page needs a
handle from a verified lookup, which cannot be built from the tracking number, so the
link shown to users is the public form.

## How it works

One step, chosen by configuration, with a 45 s budget standalone and 30 s in the chain:

- `trawl` when `FLARESOLVERR_URL` is set. TRAWL's Camoufox passes the widget check on
  the production network. A failure moves on to the next provider without trying local
  Chromium.
- `browser` otherwise: local Chromium (`TRACKING_CHROMIUM_PATH`). It returns only the
  widget's first and latest scans, and automated Chromium usually fails the Turnstile
  check.

Both paths:

1. Open `https://postal.ninja/en/tools`, fill the official embedded widget, untick "save
   this parcel" so no stored parcel is left behind, and submit. The TRAWL
   [compatibility build](../../trawl/README.md) uses `#trawl-number=<number>`
   as its own marker to trigger that submission. It is not an upstream deep link.
2. The widget gets a Turnstile token and signs its requests:
   `POST /track/check` with `{tc, ds: null, lang}` returns `PROCESSING` and a handle.
   Then `POST /track/get` with `{hid, lang, t9n: true, mode: "GET", compact: true}` (plus
   one `AWAIT` if needed) returns only `firstEv` and `lastEv`.
3. TRAWL only: once a completed reply matches the number and its own handle, the same
   session opens `/en/track#/<hid>`. That page requests `/track/get` with
   `mode: "EXISTS"` and no `compact`, which returns the full `track.events`. The capture
   wait restarts within the original budget. The app accepts the new URL only when its
   handle is bound to an identity-matched capture.

The TRAWL path requires full history: a widget-only capture falls through to the next
provider. Compact replies are accepted only on the local Chromium path.

`/track/check` can end a lookup early. A matching `CHLNG_REQ` is a challenge error, and
a matching `UNTRACEABLE` is inconclusive. `FOUND`/`NO_INFO` stay intermediate while
`inProgress` is true, and a completed empty lookup is inconclusive. Replies for other
numbers or handles cannot end the lookup.

## Protection layers

1. Cloudflare in front of the page and API: fresh Node requests get 403 with
   `cf-mitigated: challenge`.
2. Application check: the widget runs Turnstile (action `widget`) and sends the token in
   `X-RC-Token` with a `TSI` suffix. If that fails, the token is empty and the check
   returns `CHLNG_REQ`. The main entry form uses managed Turnstile (`check`, `TSM`) with a
   reCAPTCHA v2 fallback, which fails in automated sessions. This is why lookups go
   through the widget and then the results page, never the main form.
3. Signing: `X-TW-Sign` holds API version 6, a millisecond timestamp and a base64
   HMAC-SHA256 over `version;timestamp;JSON-body`, keyed by a constant in the public
   bundle. A valid signature does not replace the challenge token. The browser path
   lets the widget sign, so the adapter holds no signing constant.

## Parsing

- Identity: `status: FOUND`, `track.tc` equals the number, `track.hid` equals `hid`, and
  the state is `TRACKING`, `FINISHED`, `STOPPED` or `ARCHIVED`.
- `dt` has no zone, and its clock depends on the service that reports the scan (`ds`),
  not on where the scan happened. [clocks.ts](clocks.ts) lists the clocks established
  against the carriers' own instants on the benchmark's parcels:

  | Clock | Services | Evidence |
  |---|---|---|
  | UTC | Austrian Post, Correos de El Salvador, Intelcom, OnTrac, Poste Italiane, Raben | Austrian Post 9/9 scans, which post.at shows two hours later in summer; Poste Italiane 9/9 against its epoch times; Raben 9/9 against its epoch times, in Germany and Italy; OnTrac 14/14 on two parcels its API dates at −07:00 and −04:00; Intelcom 5/5; Correos de El Salvador's own tracker gives the same digits in UTC, and its arrival in San Salvador at 21:30:17 is UPU's 15:30 local |
  | One zone, wherever the scan happened | Swiss Post (Zurich), Singapore Post (Singapore) | Swiss Post's own scans on two items, to El Salvador and China; Singapore Post 9/9 on an item to China, with its Chinese scans |
  | One zone per network, by destination | GOFO Express: US Los Angeles, FR Paris | 20/20 on two US parcels, with New Jersey and New York scans; 7/7 on a French parcel and the newest scan of a YunExpress parcel GOFO delivered in France |
  | The scanning office's | An Post Ireland, CTT Express, Correos de España, DHL Parcel Netherlands, DPD, DPD Poland, DPD UK, GLS, Hermes Germany, MRW, Nova Poshta, Packeta, Poczta Polska, PostNord, Posten Norge, UkrPoshta | Domestic parcels in their countries, `DPD` on the Polish, German and Spanish networks; UkrPoshta's Ukrainian scans of an item to China |
  | The scanning office's, named by its location | FedEx, UPS | UPS 12/12 on two parcels across Eastern, Central and Mountain time; FedEx 16/17 on two parcels from Washington to Florida and from Ohio to Kentucky |

  Every other service's clock is unknown, but for Cainiao's steps in China (below). Two
  services also relay scans at another clock. Swiss Post relays the destination post's arrival, customs, sorting and delivery
  scans, which name no place, at that office's clock: a delivery round UPU and Correos de
  El Salvador date 12:26 in San Salvador (18:26 UTC) comes as 12:26. They are read on the
  destination's clock when it keeps one, else on Zurich's, the last guess. Correos de El
  Salvador keeps its copies of the origin post's scans, marked "(outbound)" or "(received
  by EDI)", at the origin office's clock (Geneva's departure at 12:20), read on the
  clock of the country the S10 number ends with when it keeps one; otherwise they borrow
  one, from its other copies first.
  Correos de España's copies of an origin post's scans are at that post's clock too
  ([Correos](../../carriers/correos-spain/README.md)), but Postal Ninja translates their
  wording, so they cannot be told apart and are read like its own scans.
  DHL Germany's copies of the postal union's records at a European office, which name it by its
  UPU code (`ITMILR`), give the office's wall clock read on Berlin's and written in UTC: Royal
  Mail's customs scans in Milan at 00:01 and 23:06 came at 22:01 and 21:06, its departure from
  Belfast at 00:11 British summer time at 22:11, and Swiss Post's posting at 10:05 Zurich time at
  08:05. They are placed on the office's clock in any history. Read on a carrier's zone they
  borrowed, Royal Mail's London time, they came hours early and showed beside Royal Mail's own.
  Cainiao's scans keep its feed's wall clock, each at its site's, as Cainiao's own offsets
  showed on two parcels. Its steps in China, from the seller's to the departing flight, are
  read on China's clock by their wording ([shared with ParcelsApp](../../carriers/aliexpress/clock.ts)),
  whatever the parcel's carrier: read on the Zurich clock routing passes for a Swiss Post
  item, they came six hours late. Its later scans, on the transit hub's or the
  destination's clock, borrow no zone from them.
- A fixed or network clock places its service's scans in any history. A local clock
  places them only in a full history that service reports alone, and for an S10 item
  one whose origin is its destination (`destCn`): beside other services, a service relays
  their scans at other clocks (PostNord gives PostNL's Dutch scans four hours ahead, DHL
  Germany an origin post's scans at clocks that vary by origin). Its zone is the
  destination's, else the service's (`courierZone`, as Ship24 reads its couriers'), else
  the zone routing passes for the parcel's carrier, else that of the one country the
  carrier serves (BRT's Italy). A destination on another clock than the service's may be a
  parcel that crossed a border, and establishes none. A compact widget reply's two scans
  cannot show that one service reports the whole history.
- FedEx and UPS are also placed only in a full history they report alone, each scan by
  the US state or Canadian province its location names before the country ("Atlanta, GA,
  United States"). A state with several zones is read in its majority zone, as Ship24
  and ParcelsApp read theirs: FedEx's scan in Jacob City, in the Florida panhandle on
  Central time, came out an hour early. A location without a state ("United States") or
  without a country ("Chicago, IL") establishes no clock.
- A carrier's home is no clock by itself: Poste Italiane's scans are UTC, two hours off
  Rome time in summer, and the consolidators the catalog files under China report their
  destination scans at the destination's clocks.
- Known clocks that are not established: DHL Express keeps each facility's clock, but
  names its newest US and Canadian scans without their state ("MARSHALL-USA"); Australia
  Post, Canada Post, USPS and Correios do Brasil keep the scan's clock in countries with
  several; New Zealand Post relays China Post's scans at Chinese time; 4PX gives Chinese
  scans in UTC and US scans twelve hours early. Russian Post's scans come with a UTC
  suffix on the office's wall clock: an acceptance and a delivery ParcelsApp dates at
  +03:00 and +07:00 came at the same digits. The suffix is dropped, and the scans are read
  as those of an unknown clock, so an office east of Moscow is read on Moscow's.
- A scan without an established clock borrows a zone, so that a reply whose newest scan
  names no place still has a dated newest scan: that of the nearest earlier scan of the
  same service with an established clock, else of the nearest later one, else the zone
  routing passes for the parcel's carrier, else, in a history the service reports alone,
  the one the service's name gives (`courierZone`). This is a guess. On the benchmark's
  parcels it was right for UPS's label scan, three hours off for FedEx's "Shipment
  information sent", which is at the shipper's clock, and two hours early for DHL Germany's
  copies of UPU's record of a Swiss Post item, which are in UTC, read in Zurich time. A
  scan with no zone to borrow keeps its wall time as `local_time`; an explicit offset is
  kept as it is.
- A scan whose hour is unknown keeps its wall time whatever its zone. A scan dated
  without a time is written as midnight (FedEx's pickup, Geodis's departure). UPS dates
  its scans between midnight and 1 a.m. at 12:xx (its arrival in Lenexa at 00:25 is
  12:25, and a departure from Atlanta at 00:12 comes after the delivery), so its 12:xx
  scans are not placed, except a delivery, which is read as afternoon (12:59 in Dubois,
  Wyoming).
- Once every scan has an instant, scans are ordered by it; otherwise the provider's order
  is kept, because wall times cannot be sorted against instants. If the newest scan has no
  instant, `last_update` is null, and a history with none at all is inconclusive through
  `fetchSource()`.
- A pickup deadline is no scan, and is left out: one named so (PostNord's "Last day to
  pickup", Posten Norge's "Last day for retrieval"), or any row dated more than an hour
  after the reply's `lastFetch`. A wall time counts as after it only when it is that late
  in every zone, up to UTC+14.
- The services that reported the scans (`ds`) are the reply's carrier names, hints as other
  providers' are ([providers](../README.md)): a single catalog carrier among them, such as
  Raben, is the `discovered_carrier` even where no detection rule claims the number.
- `track.toAddress` is never read. At most 1000 events.

## Rejected approaches

- Pure HTTP: signed check/get calls are challenged by Cloudflare locally and from
  production. Replaying fresh `cf_clearance` cookies with the same User-Agent still gets
  403.
- Signed full-mode `fetch` inside the verified browser: works, but the results page
  already makes that request.
- The RapidAPI integration (`IrisKoBar/app_delivery_tracking`): a separate paid service.

## Testing

`npm run test:carriers:live -- providers/postal-ninja` with
`FLARESOLVERR_URL` set: two successive lookups of a public reference, and a synthetic
untraceable number that must stay inconclusive. The local Chromium path is covered by
`testing/universalScrapers.live.test.ts` with `TRACKING_CHROMIUM_PATH`. Unit tests use
synthetic [fixtures](fixtures/README.md).

A service joins [clocks.ts](clocks.ts) on evidence only: its wall times set against the
instants the carrier's own adapter or website gives for the same scans, on more than one
parcel where possible. Raw replies can hold recipient data; keep them outside the
repository.
