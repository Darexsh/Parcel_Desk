# Ship24

First universal provider: fast, broad coverage, and useful carrier-name hints. Its
histories are sometimes sparser than other feeds for the same parcel, which is why a
richer provider that succeeds keeps affinity (see [COVERAGE.md](../COVERAGE.md)).
Persisted provider name: `Ship24`. Link shown to users:
`https://www.ship24.com/tracking?p={number}`.

## How it works

Both steps share one budget: 45 s standalone, 30 s inside the chain.

1. `direct`: one signed anonymous `POST https://www.ship24.com/api/parcels/{number}?lang=en`
   ([http.ts](http.ts)). That is the parcel as Ship24 stored it. When it says
   `to_updated`, a second signed `POST .../api/parcels/update/{_id}/mainTN/{number}`
   has Ship24 query the carriers again and returns the current history, as the web app
   does. A stored history stands if that refresh fails, takes over 15 s or returns no
   scans. Result
   labelled `tracking_source: structured-web-response`.

   Ship24 answers HTTP 404 for many couriers' parcels until the visitor names the
   courier, as the page's "Add details" dialog does. When the parcel is filed under a
   carrier listed in [couriers.ts](couriers.ts) (`TrackingInput.carrier`) and 2 s remain,
   a 404 is asked once more with that courier's code in `to_check`. A 404 to that keeps
   the first; any other failure, a rate limit included, is reported. A host lookup
   without a carrier, such as a preflight, is not asked again.
2. `browser`: the public tracking page in a fresh local Chromium
   (`TRACKING_CHROMIUM_PATH`), reading the stored-parcel response from the page. Result
   labelled `browser-session-response`.

With a Chromium configured, the direct step keeps 10 s (at most half the budget) for
the browser. A slow direct answer is Ship24 querying carriers, or a slow 404, which the
page would only ask for again.

The browser step runs only when a browser could fix the direct failure:

- Without a configured Chromium the direct failure is reported as it is.
- HTTP 429 and 5xx are reported with their `Retry-After`, so the router backs off once
  instead of asking twice.
- HTTP 404 and 410 are final: the page calls the same API and only waits out the budget.
- So is a courier Ship24 keeps for its subscribers (UPS, Royal Mail, SF Express): a 404
  saying "{courier} is not available for website.", for some only once the courier is
  named. It is a `NotFoundError` with reason `subscriber_only`; the courier's name stays
  out of it. [coverage.json](../coverage.json) records these couriers as `subscriber_only`,
  so routing does not ask Ship24 for their parcels.
- So is a parcel Ship24 knows but has no scans for after the refresh (`NoHistoryError`).

Built without an HTTP client (as in browser tests), the adapter runs the browser step
alone. Only one local browser session runs per server process; an overlapping lookup
waits its turn within its own budget.

## Request signing

The website builds an `x-ship24-token` header from a timestamp, an opaque SHA-256
digest, a MurmurHash3 checksum bound to the tracking number, and an HMAC over the three.
[http.ts](http.ts) reproduces that algorithm. The refresh request's token is simpler: the
decimal UTF-8 bytes of the salt, the time, the number and two more marker characters,
with two bytes altered. Its HMAC key, checksum salt and markers are public frontend
configuration, copied from the site scripts cited in the file, not account credentials.
No account, cookie, fingerprint or issued token is used.

- A GET on the parcel API returns 404 and an unsigned POST returns 403. A signed POST
  returns 201 with the shipment.
- Courier codes come from the public list the dialog loads,
  `api.ship24.com/backoffice/api/v1/master-couriers`. Some carriers' parcels stay 404 with
  their code named; those are not listed.
- The constants are hard-coded, not fetched at startup. Fetching the page or its asset
  CDN at runtime was blocked by CloudFront from inside the production container.

## Parsing

- A reply counts only when `data.tracking_number` matches the requested number. A
  matching reply without events is no history; while `to_updated` is still set it is
  inconclusive.
- Times come from `timestamp`, which carries the real offset. `datetime` can end in `Z`
  while holding the carrier's local time. Some legs (Chronopost, national posts, UPU
  feeds) have no offset in `timestamp`: that is the scanning office's wall clock.
- Some feeds relabel the carrier's wall clock with an offset it never had. By
  `courier.crawler_code`, checked against each carrier's own data (2026-10-10):
  - `canada-post-tracking` says `-05:00` on every scan; Canada Post says `-04:00` for
    Ottawa in October;
  - `uniuni-tracking` says `Z` on the depot's clock, as UniUni's own `pathTime` does;
  - `gofo-express-tracking` puts GOFO's `-07:00` on the clock GOFO gives the scan
    (`processTimeZone`), and names the station (`processLocation`) without its state;
  - `postnl-tracking` says `Z` on postnl.post's `datetime_local`, except on the label's
    creation and the processing record without a place, which keep UTC as PostNL's own do;
  - `amazon-uk-tracking` says `Z` on the marketplace's clock, which Amazon shows with
    none;
  - `portugal-ctt-tracking` says `Z`, as CTT's own tracker does (see CTT's README);
  - `4px-tracking` gives an instant 4PX made by reading the wall clock on China's:
    `tkDate`. Read back on China's clock, it gives the wall clock.

  Their offset is dropped and the wall clock read like an offset-less one.
- `inpost-uk-tracking` gives UTC instants with no offset: InPost's hub dates the same
  scans with one, and Collect+'s copies say `+01:00` on London's summer clock. They are
  read as UTC, not as wall clocks.
- `feia-tracking` gives 17FEIA's wall clocks, and drops the label and country of its order
  data and warehouse steps. They are read as 17FEIA's adapter reads them: those steps on
  Beijing time, a relayed scan on the clock of the country its place ends with (`(DE)`),
  and the flight's and customs' milestones as wall clocks.
- `swiss-post-tracking` puts Swiss Post's offset on the destination post's scans it relays
  (arrival, customs, sorting and delivery, with no location), which are at that office's
  clock ([Swiss Post](../../carriers/swiss-post/README.md)). On a parcel to a country with
  one clock, they are read on it (`destination_country_code`); elsewhere the offset stays,
  the last guess.
- `mainfreight-tracking` relays an air or ocean job's planned milestones without the
  "(Estimated)" Mainfreight's tracker gives them ([Mainfreight](../../carriers/mainfreight/README.md)).
  A milestone whose clock has yet to come anywhere on Earth (UTC+14) is left out. One due
  within that margin still shows. The job's scans are the port's or site's wall clock,
  wherever that is, as on Mainfreight's tracker, so in a reply with an air or ocean
  milestone ("Departure from First Load Port", "Customs Clearance Commenced") the feed's
  scans that their location does not place keep their wall clocks. Mainfreight's catalog
  clock and routing's zone, New Zealand's, are left to its transport scans.
- Correos's copies ("Correos de España") of an origin post's scans on an item from abroad,
  "En oficina de cambio" and "En aduana de origen", are at that post's clock, as on
  Correos's own tracker ([Correos](../../carriers/correos-spain/README.md)). They skip the
  steps below: they are read on the clock of the country an S10 number ends with, or stay
  wall times when it has several.
- A wall clock is read in the first clock found among:
  1. the scan location's:
     - CTT's offices of exchange (`PTLISA - …`) and own sites are on Portugal's clock,
       the Azores' for their postcodes and towns;
     - GOFO's stations are on the zone GOFO gave them on the corpus's and benchmark's
       parcels ([GOFO's clocks](../../carriers/gofo/clock.ts): "Ocala" New York's,
       "Melrose Park" Chicago's), and its unlocated "Shipping Label Created" on Pacific
       time, as GOFO dates every label. GOFO's US scans are all in the US, so a town
       named like a country ("Jamaica") names none;
     - a country named at the end, after a dash, in brackets or in Ukrainian ("Kuwait",
       "EXAMPLE - CHINA", "Pardubice (CZ)", "КИТАЙ"), when it keeps one zone;
     - else a US state or Canadian province, if the parcel starts or ends in North
       America, its courier works only there (UniUni, GOFO) or the town lies in that
       state. 4PX writes them after the country: "US  NY  EXAMPLE TOWN 12345";
     - else a bracketed code that could also name a region ("Example Town (DE)", Delaware),
       when it is the country Ship24 gives for the scan's courier (`courier.country_code`)
       and that country keeps one zone. DPD Germany's feed locates its scans so, without an
       offset, on the digits DPD Germany's own tracker dates on Berlin's clock;
  2. the country of a parcel whose origin and destination are the same
     (`origin_country_code`, or an S10 number's suffix, and `destination_country_code`);
  3. for a parcel that crosses a border, the side a UPU event's words name ("Posting/
     Collection", "Arrival at inward office of exchange", EMS's "Departed from export
     office"), from any courier, until the item is returned to sender. The origin side needs an S10 suffix that agrees with
     the origin: Asendia's Swiss numbers are posted at offices of exchange abroad;
  4. for a parcel not known to cross a border, the feed's home clock (Amazon UK's
     London, CTT's Portugal).

  A scan of one of the relabelling feeds that none of these places borrows a zone, a
  guess: the zone of the nearest earlier scan of the same feed that is placed, else of
  the nearest later one. GOFO names a delivery round after the recipient's town, which
  its stations do not list: on the 15 parcels checked, each round kept its delivery
  station's zone, which it borrows, and so does GOFO's unlocated "Loaded on Vehicle". A scan whose location names a country borrows only from one in
  that country, so Canada Post's relays of USPS scans ("CHICAGO,USA") never take a
  Toronto scan's clock. On a cross-border parcel, a scan before every placed one borrows
  only from one in the origin country: 4PX's feed lists USPS's label before the pickup
  in China.

  Then, for a parcel not known to cross a border: the clock every courier the reply
  names keeps at that moment, else the zone routing passes for the parcel's carrier.
  Last, a GOFO scan at a town the stations do not list, in a reply where no GOFO scan is
  placed, is read on Pacific time, Ship24's own label: three hours late in the East, but
  the reply keeps the instants it had.

  A courier name is the feed that relayed a scan, not where it happened: national posts
  relay the destination's scans under their own name. So a cross-border parcel's
  unlocated scan stays a `local_time`, which the timeline cannot place, rather than a
  guessed UTC instant. A reply made only of such scans is inconclusive.
- A scan dated without a time (GLS Italy's announcement) is left out: it has no place
  among the others.
- Each scan keeps its `location`, a town, region and country or a hub's code, unless it
  holds private delivery details or is Posti's "ULKOMAILLA" ("abroad"), which names no
  place. A hub's code such as "GOFO-PR" stays: the places module pins nothing for it, and
  its suffix is the hub's province for a reader who knows the codes.
- `dispatch_code_id: 7` is treated as delivered.
- `couriers[].translation.name` becomes `reported_carriers`, and becomes
  `discovered_carrier` only when exactly one name maps to a catalog id. A bare brand
  ("DPD") maps only when the number leaves one of the brand's catalog networks.
- The aggregator's delivery estimate, courier phone/website and alternate numbers are
  not kept.

## Rejected approaches

- Browser-only lookups: roughly ten times slower than the signed POST.
- Ship24's paid API: needs a merchant key. This adapter uses the website's anonymous path.
- Running the site's script to get the token: executes remote code. The algorithm is
  small enough to reproduce and review.
- Proxies, IP rotation or container network changes: not needed.

## Testing

`npm run test:carriers:live -- testing/universalScrapers.live.test.ts` with
`TRACKING_CHROMIUM_PATH` set runs the browser step against a public reference. Unit
tests use [fixtures](fixtures/README.md) and never contact Ship24.
