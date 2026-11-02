# ParcelsApp

Second universal provider. It often returns fuller histories than Ship24, especially
destination legs, and is the only provider that uses the parcel's stored delivery
postcode. Persisted provider name: `ParcelsApp`. Link shown to users:
`https://parcelsapp.com/en/tracking/{number}`.

## How it works

All steps share a 45 s budget. The router reserves the same amount, and a shorter caller
deadline still wins.

1. `direct`: [http.ts](http.ts) sends one form-encoded anonymous
   `POST https://parcelsapp.com/api/v2/parcels`, capped at 30 s because cold lookups
   aggregate on demand (later requests hit ParcelsApp's cache), and at 2 MB. It uses no
   cookies, bootstrap page, cache or redirects. A stored postcode goes in
   `extra[zipcode]`, trimmed, with leading zeros, spaces and letters kept.
2. `retry`: after a network failure or cut-off body, one more direct attempt after 2 s,
   with the same input. The public frontend retries the same way. The deadline is the
   smaller of 30 s and the remaining budget. The retry is skipped if the backoff does not
   fit. Two network failures end the lookup without a browser. A request ParcelsApp holds
   for the whole 30 s ends the lookup: for parcels it held that long from the production
   server, a retry waited out the rest of the budget too, while cold lookups answered
   within 16 s.
3. `trawl`: on a challenge (`RELOAD`) or schema drift, TRAWL (`FLARESOLVERR_URL`) loads
   the tracking page (`skipHttp`, up to tier 3) and captures `/api/v2/parcels` replies
   with a 15 s settle window. Bodies are parsed newest first, skipping polling replies
   and other shipments. If no body is readable, the rendered event list
   (`.tracking-info .parcel .events > .event`) is parsed instead.
   For a number it has no data for, ParcelsApp renders its empty view
   (`.tracking-info.empty`), which leaves out the number, so no captured reply can be
   bound to it. With the page's own `NO_DATA` or `NO_TRACKER` that is no history, as on
   the direct step; without either it is inconclusive.

Other outcomes:

- HTTP errors on the direct step. A 429 or 5xx keeps its status and `Retry-After` and gets
  no browser attempt.
- `NO_DATA`, `NO_TRACKER` and empty histories are inconclusive, not proof that the
  shipment does not exist. They end the lookup.
- `DOWN`, `BUSY`, `PARSER`, `CAPTCHA` and `MAINTENANCE` mean ParcelsApp's own lookup at
  the carrier failed: its page says the carrier's website is down, busy, unreadable,
  refusing automated tracking or under maintenance. They are inconclusive (reason
  `carrier_unavailable`) and end the lookup without a browser attempt, which would ask the
  same lookup. They say nothing about the shipment or ParcelsApp's other carriers.
- An error code the adapter does not know is a schema failure that names the code.
- A reply that only asks for a postcode raises `input_required`. Browser recovery cannot
  submit a postcode and never retries a known input gate. A gate row names the carrier
  asking, as a scan does (`states[].carrier`); when every gate names the same one and it
  maps to a catalog carrier, the error's `carrier` gives that id.

## Request construction

Built from the site's tracking bundle (`packs/js/application-….js`; the
`assets/application-….js` bundle only holds jQuery and UI code):

- `trackingId`: each ASCII character shifted by 76 modulo 126, URI-encoded, then
  form-encoded again.
- Fixed fields: `carrier=Auto-Detect`, `language=en`, `country=Unknown`,
  `platform=web-desktop`, `wd=false`, `c=true`, `p=5`, `l=3`.
- `se`: a browser telemetry string (screen and document sizes, visibility, navigator and
  WebGL properties, base64 host and stack; `undefined` is accepted for the stack),
  followed by the telemetry length, the number's length, and the unsigned MurmurHash2
  (seed 978) of `encodeURIComponent(number) + telemetry`. The adapter sends one fixed
  telemetry profile. Without the trailing checksum tuple the API returns `RELOAD`.
- A stored postcode uses `extra[zipcode]`.

`se` is a public checksum, not an issued credential, so Node alone is enough. The browser
step exists for future protocol changes.

## Parsing

- API scans retain their reported location. Chronopost's delivery-service label in that
  field is excluded because it names a service, not a place, and so are Posti's "ULKOMAILLA"
  ("abroad") and China Post's "目的国" ("destination country"). A Post Office branch's postcode, which Royal Mail appends in brackets and
  ParcelsApp copies, is left out, as Royal Mail's own adapter does, and so is the "Country"
  label ParcelsApp translates from Correios Brazil's "País" before a unit abroad, and the
  eight-digit code of the China Post office after a town. A repeat
  without a place keeps the location another copy of the same scan reported.
- Identity: the API reply does not echo the number, so a direct result is bound to the
  single POST that sent it. A different `correctId` is rejected as an unverified alias.
  A browser capture must render exactly one matching `Tracking number` row in the result
  table. The requested URL is not proof, because the page can render another shipment or
  an empty result for it.
- Times: `states[].date` is the scan's local clock, labelled as UTC or shifted into a
  wrong offset (a DPD scan at 14:05+02:00 comes back as `14:05+00:00`). The adapter
  keeps the UTC digits and re-reads them in the first zone it finds:
  1. the home clock of a network ParcelsApp names its own way (see Home clocks below),
     else the catalog zone of the scan's carrier (`carriers[state.carrier]`), unless it is
     UTC;
  2. the country at the end of `location`, past a trailing postcode ("Example Town,
     Denmark, 4600") or by the code FedEx writes before one, after a town and its region
     ("EXAMPLE TOWN, RR, IT 12345"), or the country the location reports once its "Country"
     label or a posting office's postcode alone ("PL99999") is read, if `COUNTRY_ZONES`
     ([core/time](../../core/time/index.ts)) gives it a single clock, else, for the North American scans of a few carriers, their state's
     or province's zone (see North American scans below), or for a scan in Australia, the
     zone of the state or state capital it names ("EXAMPLE TOWN NSW 2000", "SYDNEY EMS");
  3. the country that name ends with, after a catalog carrier or brand ("DPD UK",
     "GLS Italy", "DHL Parcel Netherlands"), if that country has a single clock. It comes
     after the location because the name can be a branch, not the scan's place
     ("Cainiao (China)" scanning in Spain). When the number's depot range picks another
     network of the brand, that network's zone replaces it: a DPD UK number filed under
     "DPD France" is on London time, as DPD UK's page, Ship24 and 17TRACK show. A few
     networks named without a country have their home country's clock here (Home clocks
     below);
  4. for a bare brand or brand group ("DPD Group", "GLS", "Hermes") on a scan with no
     location, the zone of that brand's catalog carriers, if every one of them reads the
     digits as the same instant, else the zone the network that labelled the parcel shares
     with the parcel's destination and, where the brand has a network, its origin (Brand
     zones below);
  5. the zone routing passes for the parcel.

  Steps 3 and 5 only guess where the scan was. A `location` ending with any other country,
  by ISO code or by name in English, German, French, Italian, Spanish or Dutch ("Example
  City, CA, US", "Example City, Brazil"), rules them out and the scan stays as
  labeled, or keeps its wall clock (below). Canada Post's "USA", 4PX's "US 12345" and
  Orange Connex's "United States of America" and "People's Republic of China" name the US
  and China too; the last also places a scan on China time in step 2. "Hong Kong", which
  is not the name Intl gives it, places a scan on Hong Kong time (2026-10-11): Dealer
  Send's and Japan Post's there have the digits Cainiao dates +08:00, and 4PX's those of
  4PX's page. A location that names no country ("Example Hub", "Toronto, ON") rules
  nothing out, and step 4 only reads scans without a location. A country added to `COUNTRY_ZONES`, or a country name newly read
  (by `countryCode` or here), therefore moves the stored scans located in it, as a changed
  catalog `timezone` moves its carrier's, and so their event ids. So does a reported name
  newly mapped to a catalog carrier on a local clock (`NAME_ALIASES` in
  [hints.ts](../../core/catalog/hints.ts)), for the scans under that name. See Limitations
  for what that does to stored rows.

  A network that no step places, whose scans other carriers copy at the same digits and
  wording on one shared zone, takes that zone, so each scan stays one with its copies.
  A scan that only steps 3 to 5 date, or none, takes the zone of another carrier's scan
  at the same digits and place (the location's first part) that its place dates: Saudi
  Post's copy of a departure from Sydney, in SPL's words at its office "SYDNEY", has the
  digits of EMS's at "Sydney". Copies on different clocks give none.

  With no zone, an offset is taken as given, which for the carriers whose dates are never
  instants (Wall clocks below) is only the last guess. Steps 3 and 4 choose a zone only:
  `carrierIdFromName` still treats these brands as ambiguous, so discovery and routing
  are unchanged.

  A scan with no location that only step 5 or the label dates, and that comes out more
  than an hour after the read, is on another clock: a Cainiao step on China's wall clock,
  read on EcoScooting's UTC, came out hours ahead. It is left out until a read catches up
  with it, in the rendered page too. A scan that its carrier's clock or its place dates
  keeps its time, so that a wrong clock there still shows.

  Three kinds of scan with no zone keep their wall clock in `local_time` instead, with no
  instant. One names no carrier, or a network that
  neither the catalog nor the tables here know ("Example Parcel Co"): nothing says its
  label is an instant. Another names a bare brand whose catalog networks all keep local
  clocks ("DPD Group", "GLS"; Brand zones below): its label is the wall clock of whichever
  network scanned it. The third is at a US military post office ("Fpo, AE", "APO AP
  96001"), which names no country: AE there is the Armed Forces Europe, not the Emirates,
  and the base can be anywhere in its region, so no guess and no zone of the scans around
  it fits. Each stays a scan: as the latest one it sets the stage with `last_update` null,
  and it moves no freshness watermark. Another carrier's acceptance is a hand-over to it
  once a different carrier moved the parcel before. A wall clock is later than a move by
  more than a day, or as soon as it would sort above a dated one.
- A state with no `date` (an Asendia Spain leg listed after dated US scans), or with an
  offset-less date that no zone resolves, but for the scans above that keep their wall
  clock, has no instant. It is skipped and counted in `undated_event_count`, so it never
  becomes the latest scan, sets the stage or `last_update`, or moves the freshness
  watermark. A malformed date still fails the reply.
- A state at 1 January 00:00 more than 60 days before every other dated scan has a
  placeholder for a date, and is counted the same way. ParcelsApp relays the steps of
  DPD's progress bar ("Package on the way") and gives this date to those DPD leaves
  undated, months before the parcel's scans. A real scan at that minute lies among the
  scans of the turn of the year and keeps its date, as does a reply with no other dated
  scan to compare with.
- FedEx's pickup ("Picked Up") at 00:00 keeps its day in `local_time`, with no time:
  FedEx's own feed sends that step with a date, a 00:00:00 time and no offset, and every
  other scan with its offset and time. Read at midnight on the pickup's clock, it took a
  time FedEx never gives. It stays a scan, so when it is the latest one `last_update` is
  null. BRT's "FOR DELIVERY" at 00:00 keeps its day the same way: BRT's page gives that
  step a date and no time. So do USPS's pre-shipment notice and its place-less "In Transit
  to Next Facility", which USPS dates by the day alone: read on the clock of a placed scan
  near them, they came at a US midnight. A pickup at another time, another FedEx, BRT or
  USPS scan at 00:00 and other carriers' midnight scans keep their instants. Such a step is
  left out when a timed scan of another network shows the same stage that day, as DPD
  Germany's "Parcel out for delivery" does BRT's "FOR DELIVERY" on a parcel BRT hands to
  it: without a time, the copy has no place among that day's scans.
- A network whose every scan in the reply is at 00:00, at least three of them over two
  days or more, keeps their days in `local_time` the same way. ParcelsApp writes
  Shiprocket's scans so, while Shiprocket's own tracker gives each its minute. So does a
  network whose scans, again three or more over two days or more, sit on one minute with
  whole seconds counting them one by one in the reply's order (07:00:00, 07:00:01…), as
  ParcelsApp writes CDEK's and SEUR's while CDEK's own lookup has each scan's instant; the
  rendered page prints no seconds, so there one minute for all is enough. The day is that
  of ParcelsApp's digits, the network's clock, not the UTC day of the instant they read as.
- DHL Express scans carry the facility's clock, whatever the label: DHL's mobile API gives
  the same clocks scan for scan, and Ship24 gives them with the facility's offset. They
  skip the steps above and take the zone the
  [DHL Express rule](../../carriers/dhl-express/clock.ts) reads from their location. A scan
  the rule cannot place is a wall
  time: it is left out and counted like an undated state. When it is the reply's latest
  scan the reply is inconclusive ("cannot place the latest DHL Express scan"), so an older
  scan does not stand in for the parcel's state and routing asks the next source. The
  rendered page prints no location, so it places none of them.
- SwiftX's dates are its sites' wall clocks: its own tracker gives each scan its site's
  offset ([SwiftX](../../carriers/swiftx/README.md)). ParcelsApp writes the site after the
  country and town, with no state ("US, EXAMPLE TOWN, EWR HUB"), and a site the adapter
  lists gives its zone: read on Eastern time, the EWR hub's digits have to the second the
  instants of DHLink's copies of the same scans, which DHLink dates on China's clock, and
  the New Jersey warehouse's those of SwiftX's own tracker. The ORD hub, at Chicago O'Hare,
  is on Central time, where KTD's copies under the hub's town and state put the same
  digits. A delivery names the recipient's
  town and no site; SwiftX's tracker gives it the offset of the warehouse that sent it out,
  so it takes the newest listed site's zone before it. Other sites keep SwiftX's catalog
  zone, Pacific, in step 1. Its labels ("Shipping Label
  Created") take GMT-07:00, which its own tracker gives them in every season. The rendered
  page prints no location, so it places no site.
- On a parcel to the US, DHLink's feed can hold a partner's scan twice: its own row on
  China's clock and the partner's copy on its US wall clock, as the
  [DHLink adapter](../../carriers/dhlink/README.md) reads them. ParcelsApp files both under
  DHLink, and read on China's clock, a copy of SwiftX's label came 15 hours early. A DHLink
  scan whose US reading is the instant of another DHLink scan with the same wording is that
  copy and is dropped. So is a DHLink scan with the wording and digits of the partner's own
  row: the reply can hold SwiftX's copies of its hub scans without DHLink's rows.
- Wall clocks: the dates of USPS, Canada Post, GOFO's US scans, SpeedPAK, EMS, Cainiao,
  EcoScooting, 4PX, MailAmericas and FIRST LINE abroad are each scan's local clock under a label that is
  never its instant (checked 2026-10-10 scan for scan: USPS's page and the "at 8:25 am" in
  the status text ParcelsApp relays; Canada Post's own digits; GOFO's US feed, which gives
  the offsets; Orange Connex's times and offsets for SpeedPAK; the EMS office clocks
  Parcelforce and NZ Post relay; Cainiao's leg by leg, on GMT+8, +2 or +1, also under
  EcoScooting, whose Spanish and Portuguese scans differ by an hour; MailAmericas' older
  tracker, which gave each scan its site's offset). Such a scan skips the steps above and
  takes the first zone of:
  1. its place: the state or province (North American scans below) or the single-clock
     country its location names;
  2. a copy: the zone of another carrier's scan at the same minute with the same wording
     that the reply places by its carrier's zone, its place or its offset, not by a guess
     (EMS's "Delivered" and Japan Post's "Final delivery" in the UK). The copy then reads
     as the same instant and merges into that scan's row. Two such scans on different
     clocks give no copy. A scan written to the minute alone, at :00, is copied by one
     that keeps its seconds: Cainiao relays YFH's scans with their seconds and no place,
     and its own tracker gives them GMT+08:00, the clock YFH's are read on;
  3. a borrowed clock, a guess: the zone of the scan of the same network just before it by
     wall clock that steps 1 or 2 place, else of the one just after it; for a scan known
     to be in the destination (Known clocks below), only of one placed there;
  4. the known clock of its network and wording, or for a scan in the destination, that
     country's single clock (Known clocks below);
  5. the zone routing passes for the parcel (step 5 above), a guess. It is the zone of the
     carrier the parcel is filed under, so it comes after the known clock: Lagos's, for a
     parcel filed under Speedaf, put Cainiao's copies 7 hours late;
  6. none: it keeps ParcelsApp's label, as it did before these steps, and reads as that
     label says, hours off unless the scan was on UTC. This last guess means no wall-clock
     scan is left without an instant, so none drops out or makes a reply inconclusive,
     but for one at a US military post office, which keeps its wall clock (above).

  A zone the scan's location rules out is skipped: a scan in "USA" takes no Canadian or
  Chinese zone. Step 3 holds when the scan happens where its neighbours do, and is hours
  off when it does not. Checked on 2026-10-10 against the carriers' own clocks: Canada
  Post's first scan and one in Chicago took the right zone, and its last two, in Montana,
  the Chicago hub's, an hour off USPS's. SpeedPAK's four took the right one, and a Chinese
  system event the US one, 14 hours off. On 2026-10-11, with the known clocks below, all
  26 scans of a 4PX parcel took 4PX's own offsets, and 27 of another's 30; the other three
  are an hour off, where the parcel or 4PX's clock changed zones around them. No source
  gives the clock of USPS's "In Transit to Next Facility", which borrows its neighbours'.
  Routing passes no zone for a carrier on UTC in the catalog, as these are, so step 5
  rarely applies. Step 6 is reached by Cainiao's last mile in the UK, which is on GMT, by
  Cainiao scans of unlisted wording or in a reply that names no destination, and by EMS
  scans in a reply that places none of EMS's: a cancelled export in China, and US scans
  under a Chicago postcode in a reply that names neither the US nor a state.
- Known clocks, from each carrier's own offsets. GOFO's feed dates its labels ("Shipping
  Label Created") on Pacific time wherever the parcel is injected (a Florida parcel's at
  -07:00; 2026-10-10). Cainiao's own feed (2026-10-11, parcels to the UK, Belgium, Spain,
  Italy, Japan, Brazil and the US) dates its origin leg on China time, from "Order
  received successfully" to "Left from departure country/region", and its return
  warehouse too. That leg includes the warehouse's own steps ("Shipment information
  received by warehouse electronically" to "Package shipped out from warehouse") and the
  origin sorting center's ("Processing at sorting center", "Departed from sorting
  center"), which AliExpress's feed dates +08:00 in mainland China and Hong Kong.
  "Carrier update" is not listed: besides its own notices, on China time, Cainiao words its
  transit sorting centers' scans that way. The seller's step before them ("Pending shipping by the seller") is on
  China time as well: read as labeled, it comes after ParcelsApp first returns it. It
  dates import customs ("Import clearance start" to "Leaving customs") and the last mile
  ("Received by local delivery company", "Out for delivery", "Delivered", and bpost's and
  CTT's wording) on the destination's clock, except the UK's last mile, on GMT in July.
  Its transit hub, on GMT+2 for a UK parcel, and "Arrived at
  linehaul office", on either side's clock, are not listed: a parcel to Colombia reached
  that office four minutes before MailAmericas' "Delivered by Airline" there. A parcel
  bound for Portugal clears customs in Spain, on
  Madrid's clock: AliExpress's own "Departed from customs" and the Madrid customs broker's
  scans have the digits of Cainiao's import customs. EcoScooting's sorting-center sentences
  that Cainiao relays ("Your shipment has arrived at sorting center") are on Madrid's clock
  too, also for a parcel bound for Portugal. 4PX's page (two parcels to the US) dates its scans up to
  the departing flight on China time and the rest in the US. Its destination partner's
  sorting center ("Your shipment has been processed at sorting center and ready for
  shipping"), which a parcel to France reaches before any placed scan, is on the
  destination's clock. EcoScooting's own instants
  (two parcels) put its China leg on China time, its order and its Spanish sorting
  center on Madrid's, and its last mile on the destination's. MailAmericas dates its
  origin leg ("Order created", "Transit to destination country") and its Tax ID checks,
  logged with the label, on the origin's clock, and its scans from "Arrived at destination
  country" on the destination's. On a parcel from China to Colombia, the Tax ID checks
  were dated up to six hours after ParcelsApp first returned them, and come before that
  moment only on China's clock; the scans in Colombia matched Cainiao's import customs to
  the minute, and "Container reception" AliExpress's own receipt by the local delivery
  company, which states its offset. EMS dates its scans at the destination's office of exchange ("Arrived at
  destination import office" to "Departed from destination import office", its holds and
  import customs between) on the destination's clock, as it dates its origin leg on the
  origin's: on a parcel from the UK to South Africa they have the digits of the South
  African post's own copies, and its unplaced "Held for customs inspection" those of
  UPU's "Held by customs" at the Johannesburg office. Borrowed from the British scans
  before them, they came an hour late. FIRST LINE ("1ST") dates its scans in China and Hong Kong, and its order data
  with no place, on Beijing's clock, as 17TRACK's copies do. Its scans abroad are its
  delivery partner's, on their facility's clock, and from "Arrived at Destination Airport"
  they are in the destination: on a parcel to California, its copies of GOFO's scans had
  GOFO's digits, and read on Beijing's clock, its arrival in Los Angeles came twelve
  minutes after the flight left Shenzhen.

  The destination is the country the reply names (`destinationCode` or `destination`),
  else the one an EcoScooting reference names ("CNPRT" for Portugal, "CNESP" for Spain).
  The origin is the country the reply names as `originCode` or `origin`.
  A scan on a fixed clock skips step 3, since its neighbours keep another clock: borrowed
  from a GOFO parcel's Florida scans, the label came 3 hours early and Cainiao's "Order
  received" 12 hours after it, where China time puts it 19 seconds after. A scan in the
  destination borrows only from a scan placed there, so 4PX's arrival in the US takes a
  US scan's clock, not that of the Chinese scan before it, and otherwise takes the
  country's single clock. In a reply that names no destination, Cainiao's and
  4PX's go through the steps like any, and EcoScooting's last mile takes Madrid's. Other
  scans of these networks with no place go through the steps like any.
- Steps 1 to 5 move the stored scans they now date, and the names read as the US or China
  above move theirs (see Limitations). A copy merged into the scan it copies leaves one row
  where there were two.
- ParcelsApp's 4PX dates are the wall clocks of 4PX's page under a UTC label, whether it keeps
  4PX's place fields, the country first ("US  NY  EXAMPLE CITY 12345", "CN", "FR"), or
  rewrites them ("United States", "Hong Kong"). Those fields are no sign of the instants of
  4PX's own feed, which read every wall clock on China time: the same parcels now come with
  the wall clocks, and reading them as such instants put scans up to 8 hours late, some
  after the lookup.
- GOFO France's dates carry real offsets ("+02:00"), the instants of GOFO France's own
  feed, and are taken as given. Other carriers' copies of the same scan (YTO's, Cirro's,
  EQuick China's) write its digits under a UTC label; a copy with the same digits and
  wording takes that offset, so it does not stand as a later or earlier scan.
- Poland Post's dates at a place, a Polish office or Poczta Polska's sender platform
  ("Electronic Sender"), carry the digits and offset of Poczta Polska's own tracker and are
  taken as given, whatever zone routing passes for a parcel filed under the line carrier
  that sent it. La Poste's scans it files at a country alone ("Country: Poland",
  "PL99999") are no office's: their UTC digits are La Poste's clock, shifted into Poland's
  offset, and are read on that country's clock. Its relays from abroad, with no place or
  at the "International Postal System", put Poland's offset on the other country's clock. Their digits are read as
  written on the partner post's clock that Poczta Polska's own adapter uses: the post that
  issued an S10 number from abroad, else a destination abroad. With neither, they are read
  as before.
- Croatia Post's dates have the digits of Hrvatska pošta's tracker under a UTC label. A
  scan at a facility abroad, named by its UPU office code, is on that facility's clock when
  the code names a country keeping one, else it keeps its wall clock, as Hrvatska pošta's
  own adapter reads it. Read on Zagreb's clock, a British office's scans came out an hour
  early. A scan without an office, which can be the destination post's, keeps its wall
  clock as there; the other scans take Zagreb's clock.
- JS Express's, ECMS's and KTD's dates are the clock of each scan's place, not the China time
  of their catalog zone. JS Express's own feed gives the same digits with China's offset at
  its Chinese warehouse, the Netherlands' at Schiphol and the destination courier's at the
  courier's scans: read on China's clock, its scans at Schiphol came six hours early, and a
  landing at JFK under five hours after the flight left China. ECMS's own tracker gives
  them each facility's offset, Japan's at Narita, where China's clock put them an hour
  after ECMS's own rows. KTD files SwiftX's hub scans at SwiftX's digits under the hub's
  town and state, and on China's clock its flight from Shanghai landed in Chicago 75
  minutes after take-off. A scan in China takes Beijing's clock, except a JS Express
  flight's departure filed there, which keeps its wall clock as in JS Express's own
  adapter. A scan elsewhere takes the clock of the US state or Canadian province its place
  names for certain, else the single clock of the country it names; one with no place,
  only a town or a country of several clocks keeps its wall clock. This is no rule for
  every line on China's clock: Hualei's tenants (Mayi Yinfu) and DHLink date their scans
  abroad on Beijing time.
- Home clocks: some networks are named their own way, and their dates are their own
  instants or labels shown on their home clock wherever the scan was (checked
  2026-10-10). "Italy Post" has Poste Italiane's epoch milliseconds on Rome time. "New
  Zealand Post" has NZ Post's UTC instants on Auckland time, also for the scans it relays
  from abroad ("Hong Kong"). "Singapore Post" has SingPost's "+08:00" digits, also for its
  scans in China, and "SunYou - Sytrack" those of the origin leg of SunYou's feed, on
  "+08:00". "Landmark Global" has its tracking page's US Central clock, also for the
  partner scans it relays. Step 1 reads them on that clock. SunYou's feed dates its destination leg,
  from "Arrived At Destination Country Airport" to the delivery, on the destination's clock
  ("+02:00" for Spain, where EcoScooting's own instants agree), so those scans take the
  destination's single clock, or else only a guess. "iMile" has the digits of iMile's
  page, which writes every scan on the recipient country's clock, wherever it was: they
  take the destination's single clock, or else keep their wall clock, as iMile's own
  lookup does. "Royal Mail", "Parcelforce" and "Parcelforce Worldwide" have the labels
  of Royal Mail's tracker, on London time at home and beyond Europe: a South African
  office's scans have the instants of the South African post's own clock that way.
  Their European partners' relays are on another clock (below). Correios Brazil's ("Brazil
  Post") have the digits of Correios' own tracker, whose rows name America/Sao_Paulo, in
  Brazil and in the origin country, and 17TRACK's -03:00 copies agree: they are read on
  Brasília's clock, which the catalog's UTC and Brazil's several zones left out. "South Korea Post"
  (Korea Post's page) and "Posten Norge - Norway Post" (Bring's offsets, in Denmark too) were
  checked at home only, so their home clock is a step 3 guess that a location in another
  country rules out. So was "Japan Post" (2026-10-11): Japan Post's portal gives local
  times, 10:27 for a delivery in Japan that Cainiao dates 10:27 GMT+9 and Ship24 01:27Z.
  So were "Yodel" and "InPost UK", InPost's UK network, and "Collect+", Yodel's shop
  network, on London time: InPost's own offsets give the same instants. So was "XZG", a
  Shenzhen line provider that DHLink relays, on China time: XZG's own tracker and DHLink's
  give its digits, and DHLink records its warehouse scans within seconds on its system
  clock, which is China's. DHLink's copies take DHLink's catalog zone, so XZG's scans stay
  one with them whether a reply has them or not, whatever zone routing passes. So was
  "SPL", Saudi Post, on Riyadh time: its own tracker dates an origin post's scans and an
  EMS partner's abroad on their own place's clock ([Saudi Post](../../carriers/saudi-post/README.md)),
  so a location in another country, or a copy at the same place (above), dates them
  instead. So was "BRT Bartolini", with or without the identifier type in brackets, on
  Rome time: its dates have the digits of BRT's own page, which writes its depots'
  Italian wall clocks; BRT's catalog zone, UTC, read them two hours late in summer.
  So was "South Africa Post Office", on Johannesburg time: on a parcel from the UK, its
  copy of the departure from the British office of exchange has the digits of Royal
  Mail's own scan, on London time, so a location in another country dates its scans
  instead; read in the catalog zone, that copy came an hour early.
  Royal Mail's relays of its partners' scans abroad are on Central European time
  whatever the country's clock: its receipt and departure at France's office of exchange
  have the digits of La Poste's own scans, and its "Item Received" and customs scans in
  Portugal come an hour after CTT's digits, at the same minute. Step 1 reads a Royal Mail
  scan located in another European country on Brussels time, and so one with no place that
  puts the item "in the destination country" on a parcel bound there, and so for
  Parcelforce's names. A name or relay added here moves its stored scans (see Limitations).
- Pitney Bowes's London clock is only its UK hub's. Its other scans are read as Pitney
  Bowes's own adapter reads them: Interpost's import declaration and clearance, placed by a
  country alone ("Customs Clearance" at "IT"), on that country's clock; the platform's
  unplaced scans at the hub ("In Transit", "Item processed at Interpost", the hand-over) on
  their fixed clocks; and the destination post's scans it relays with no place on the
  destination's single clock, else as wall clocks. Its relays of Poste Italiane's delivery
  have the digits of Poste's own instant on Rome time. "TrackYourParcel" relays the same
  scans at the same digits in its own words, and takes the clock of Pitney Bowes's scans at
  the same minute. Read on London's, they came an hour or two off Pitney Bowes's own rows.
- China Post's dates are its scans' wall clocks under a UTC label. A scan whose place is
  written in Chinese, ends with a mainland province ("Example City, Guangdong") or is only
  the city of one of its processing centres ("Shenzhen") is read on China time, as
  17TRACK's "+08:00" copies of the same scans are. Its other scans go through the steps
  like any, and one that no step places, with no place or one they cannot tell ("Example
  Town ENG GB AB1"), is read on China time too: 17TRACK's "+08:00" copies of its airline
  handovers and of its scans at such places have the same digits. Its copies of the
  destination post's scans, placed by the start of the destination's Chinese name ("哥伦"
  for Colombia) or sent from its office abroad ("境外经转局"), have that post's digits, as
  UPU's copies at the destination's office of exchange show: they are read on the
  destination's single clock, else kept as wall clocks. So are its English copies whose
  place is in the destination, by the country's name or, on an item to the US or Canada, a
  state or province. A copy at a place of China Post's own ("Final delivery" at a code)
  takes the zone of another network's scan at the same minute in the destination, the
  post's own or UPU's: on an item to New Zealand, its delivery had the minute of New Zealand
  Post's, and read on China's clock came five hours later. Its UPU and EMS scans come under
  those names, their place a code or a postcode ("GZSGJHHJ", Guangzhou's office of
  exchange). Theirs from posting to
  departure from the office of exchange are read on the origin's clock, the reply's
  `originCode` or the country of an S10 number: they share their digits with China Post's
  scans in China, and read as UTC export customs came after the release. UPU's scans placed
  only by the code of an office in the destination keep their wall clock for the places step
  to date: they have the destination post's digits, and a town's name ("MADRID") is read
  first. On an item to the US, one placed by a ZIP Code alone is on that state's clock. Australia has several clocks, so an Australian origin's scans take the state or
  state capital their place names, as Australia Post's own offsets do; one naming neither
  stays a guess. A posting names its office, which can be in another state than the scan:
  UPU's "BRISBANE" posting of an item Australia Post received in New South Wales has the
  digits of Australia Post's "+11:00", as does EMS's copy under the office's code. A posting that only its
  office's capital places therefore borrows the clock of its feed's other scans, as a wall
  clock does (step 3 of Wall clocks), and takes the capital's only when there is none.
  A UPU or EMS scan whose place puts it only in another country of several clocks
  ("CURITIBA, Brazil") is read on the clock most of that country's people live on: Correos
  Chile dates a posting UPU names in Santiago, and Correios Brazil an arrival in Curitiba,
  at the same digits on their own clocks. The US, Canada and Australia are left to their
  states, and a state's code ("EXAMPLE CITY, MN") names no country.
- CTT's copies ("Portugal Post - Portugal CTT") have the digits of CTT's own tracker, the
  clock where each scan happened, under a UTC label. An office of exchange or a CTT site
  names its own clock ("GBLALA - …" London's, "PTLISE - …" Lisbon's). ParcelsApp drops
  CTT's event codes, so the Portuguese offices of exchange tell the side of the border: on
  mail from abroad, a scan before the first of them is on the origin's clock; bound
  abroad, one after the last is on the destination's; any other is on Portugal's. Read as
  UTC, a UK parcel's scans came an hour late in summer.
- bpost's copies ("Bpost Belgium") of an office of exchange abroad, which name the office
  and its country, are on that office's clock, and step 2 reads them so: Landmark's page
  relays a London office's departure at that instant, and bpost's unplaced "Item has passed
  a checkpoint" falls at the same instant on Brussels time, as bpost's copies with no place
  do (step 3).
- Correos's copies ("Spain Post") of an origin post's scans on an item from abroad, "En
  oficina de cambio" and "En aduana de origen", are at that post's clock, as on Correos's
  own tracker ([Correos](../../carriers/correos-spain/README.md)). They are read on the
  clock of the country an S10 number ends with, or stay wall times when it has several.
- Correo Uruguayo's copies of a sending post's scans name that post's country ("CHINA")
  and are on its clock, as on Correo Uruguayo's own tracker
  ([Correo Uruguayo](../../carriers/correo-uruguayo/README.md)), or stay wall times when it
  has several. Read on Montevideo's clock, China Post's posting came eleven hours after China
  Post's own row of it.
- Speedaf's dates are its sites' wall clocks under a UTC label. Its own feed dates the
  scans up to the departing flight ("Cargo flight departured") on China time and the rest
  on the destination's, and Cainiao's copies of the same scans agree once read that way.
  Scans whose digits come after the flight's take the destination's single clock, or
  else go through the steps; the others, and all of them before the flight, are read on
  China time. Cainiao's copies in a reply with that flight are read the same way, not on
  Cainiao's known clocks: its "Arrived at linehaul office" has the digits of Speedaf's
  "Cargo flight arrived" in the destination.
- TNT's international scans (9-digit numbers) skip these steps. tnt.com gives them
  offsets, and ParcelsApp's `date` is already their UTC instant.
- So do scans named "Asendia United States" or "Asendia USA", wherever they happened.
  Their dates are the UTC instants of Asendia's A1 feed, and Swiss Post's own scans of
  the same item agree (the Asendia USA references in
  [numbers.json](../../carriers/asendia/numbers.json)). The same A1 scans filed under
  another name are not UTC: an eBay shipment's, under "EasyShip", carry local clocks
  (Ship24's instants and Swiss Post's own scan agree once they are read that way), so
  they go through the steps like any other scan, US ones included (below). Those that
  name only the country borrow the clock of one of theirs that a state places, else stay
  as labeled, hours early.
- So do Paack's scans. Paack's timeline gives instants, not wall clocks, and ParcelsApp's
  `date` is their UTC instant: Paack's own lookup gives the same instants scan for scan.
  Read on Paack's Paris clock, they came out two hours early in summer.
- So do Vinted Go's scans: Vinted Go's own instants, in the Netherlands and Spain, have
  ParcelsApp's UTC digits to the second.
- So do Austrian Post's scans: its own instants have ParcelsApp's UTC digits to the second.
  EURODIS's copies of the same scans carry the wall clock and go through the steps.
- So do Straightship's scans: its page writes every clock in UTC, and its own rows have
  ParcelsApp's UTC digits to the second. Read on its Vancouver clock, they came out seven
  hours late.
- So do PostNL's scans in Britain. FedEx International Connect lists the same scans two hours
  after ParcelsApp's digits, on Dutch summer time, so those digits are their UTC instants. Read
  on PostNL's Amsterdam clock, they came out two hours early. PostNL's other scans keep it.
- North American scans: the dates of UPS, FedEx, UniUni, EasyShip and DHL eCommerce are
  the scan's local clock, as UPS's own instants, FedEx's own page, UniUni's own feed,
  Ship24's offsets and DHL eCommerce's Webtrack, which names each scan's clock, show on US
  scans (UPS's also in Germany, the Netherlands and Spain, DHL eCommerce's in the UK; no
  public Canadian reference was found), and so are those of the wall-clock carriers above.
  Step 2 reads them in the zone of the US state or Canadian province the location names
  ("Riverside, CA, US", "Charlotte, NC", "Linden, NJ 12345", "Scranton PA", "Mississauga,
  ON, CA", 4PX's "EXAMPLE CITY, IN, US 12345", USPS's "EXAMPLE CITY IL DISTRIBUTION
  CENTER" and "ISC EXAMPLE CITY IL (USPS)"), the majority zone where there are several, as
  in the USPS adapter. A state written out counts only after the country ("Example City
  Minnesota, United States of America", as Orange Connex writes SpeedPAK's), since Georgia
  is a country too. A code shared with a single-clock country (CO, DE, IL, IN, MT, NL, SK)
  counts, before that country, only for a town of the state or province: UPS writes both
  "Chicago, IL" and "Koeln, DE". Such a town is never read in the country, whatever the
  carrier: "Denver, CO" is not in Colombia. The town lists come from the server's GeoNames
  gazetteer,
  and a name the country also has for more people stays the country's ("Salem, IN").
  [generate-region-towns.mjs](../../scripts/generate-region-towns.mjs) writes them.
  Another shared code ("GA" is Gabon) counts only in a reply that is in North America: one
  scan certainly is, or one names a state or province and none names another country. A
  copy of such a scan from another carrier, at the same minute with the same wording
  (Cainiao relaying UniUni, YunExpress relaying GOFO), takes the same zone. Other carriers
  keep their readings: OnTrac's dates are UTC. A scan of these carriers that its location
  places only in the US or Canada
  ("US 12345", "United States") borrows like a wall-clock scan (step 3 above), from a scan
  of its network that a place gives a zone: FedEx's "Shipment information sent to FedEx"
  under the shipper's ZIP code took the zone of the pickup's state, as FedEx's own page
  dates it. Their other scans that nothing places, and those with nothing to borrow, still
  stay as labeled, except a UPS or FedEx scan with no location. Their own trackers date
  those at the same digits on a local clock: "Shipper created a label" and "Order
  Created" not always on the pickup's, UPS's customs scan at the clearing agency on the
  destination's. So such a scan is a wall time, left out and counted like an undated
  state, unless routing's zone dates it. UniUni's "UNI DATA CENTER" scans have the UTC
  instants of UniUni's own feed and keep their label. Adding a carrier, a town or a
  province moves stored scans (see Limitations).
- TIPSA's `date` has the digits of TIPSA's own shipment page, which keeps Madrid time for
  every agency ([TIPSA](../../carriers/tipsa/README.md)), so step 1 reads its Portuguese
  scans on Madrid time too.
- CTTYEX's tracker prints every row on Beijing time, the rows abroad too
  ([CTTYEX](../../carriers/cttyex/README.md)), so step 1 reads every CTTYEX scan on that
  catalog zone, an arrival at the destination airport as much as its steps in China.
- Brand zones: a bare brand does not say which network scanned. The GLS and Hermes
  carriers in the catalog all keep Central European time, which step 4 checks for each
  scan, DST changes included. DPD's do not (DPD UK's, Ireland's, Portugal's and South
  Africa's). A "DPD Group" scan takes the zone of the DPD network whose depot range the
  number asked, or a number ParcelsApp names next for the parcel (`next_tracking_ids`),
  falls in, when the destination and, if DPD has a network there, the origin keep the
  same clock. A line carrier's parcel from China that DPD Switzerland delivers names DPD
  Switzerland's number next, and its "DPD Group" scan has the digits DPD Switzerland's
  own tracker dates "+02:00". Otherwise, unless routing passes a zone, it keeps its wall
  clock: DPD Germany's own tracker dates a "DPD Group" handover two hours before the
  label. A brand with a UTC carrier (DHL, through DHL eCommerce) gets no zone and keeps
  its label. A location that names no single-clock country ("Toronto, ON", "Chicago, US")
  can be one of the brand's networks outside the catalog, so step 4 skips any scan with a
  location, which keeps its wall clock too. A location-less GLS or Hermes scan from such a
  network would still be read as Central European time.
- Brand zones follow the catalog. A new GLS or Hermes carrier, or a changed `timezone`, on
  another clock turns step 4's shared zone off for that brand, and a new DPD network or
  depot range changes which parcels it dates. Either moves stored scans, and so their
  event ids (see Limitations).
  `hints.test.ts` pins the current zone sets so the change cannot pass unnoticed.
- The rendered page prints the same UTC digits (`dd LLL yyyy HH:mm`) and names each
  scan's carrier under its wording (`.event-content .carrier`), so it goes through the
  same steps and gives the same instants, and event ids, as the JSON reply. It shows no
  scan location, so step 2 never applies there and nothing rules out steps 3 and 5. A
  wall-clock carrier's scan there has no place to be read in and no placed scan to copy or
  borrow from, so routing's zone, a guess, dates it, else its known clock, else its label,
  and its UTC digits carry no offset for GOFO France's copies to take. Nor can it tell
  which UPS or FedEx scans have no location, so routing's zone dates all of theirs, else
  their label. The page names no destination, so only an EcoScooting reference gives one there, and a
  "DPD Group" scan takes no clock from DPD's networks (step 4). The server's timezone is
  never used. It prints a state with no date as `aN Inv NaN` at `aN:aN`, which
  is counted the same way, as is a placeholder date.
- An acceptance by one carrier after another already moved the parcel (in transit or in
  customs) reads as in transit: DPD's "Parcel handed" when it takes a cleared parcel from
  the line carrier is a hand-over, not a new start. An acceptance on a wall clock that
  would sort above another carrier's dated move is one too, though within a day it may
  come first, so it never sets the stage back over that move.
- A bare "Delivered" is left out when a scan of the reply moves the parcel on (accepted,
  in transit, in customs, out for delivery or a failed attempt) more than a day later.
  ParcelsApp words a leg's end so: a first carrier's on the day it hands the parcel to the
  next, and MailAmericas' "Delivered by Airline" before the destination's customs. The day
  covers the hours a reply's networks' clocks can stand apart.
- Russian Post's summary of a delivery ("Вручено 22 октября") names no carrier and comes on the
  delivery office's wall clock, while Russian Post's own scans have Moscow time's digits. A
  summary in the delivered stage whole hours, from one to twelve, from a dated delivery
  repeats it and is left out; read as UTC it put the delivery hours late.
- MailAmericas' hand-overs in the destination country read as in transit in English and
  in Spanish ("Entregado por Aerolínea", "Entregado a Distribuidor"); only its finished
  process is the delivery.
- Cross-border replies stay uncertain: scans can be filed under the wrong operator (an
  India-to-France parcel listed La Poste scans under India Post).
- Notices are skipped, not events: `require_fields` rows, postcode, sign-in and
  destination-country prompts, and rows rendered with a date but no time.
- Some carriers' labels arrive written twice (TIPSA's `ENTREGADOENTREGADO`). A label made
  of two identical halves is read once, in the JSON reply and on the rendered page; any
  other label is kept as sent.
- Chronopost's notice to the recipient arrives with its message type and medium appended
  ("… Type du message : …"). It is read as the notice alone, as Chronopost's own tracker
  lists it; the shared event builder does this for every provider.
- `carriers` and `services[].name` become `reported_carriers`. They include carriers
  ParcelsApp asked without an answer, so `discovered_carrier` comes from the one name
  they list, or else from the carrier every scan names (`states[].carrier`), when that
  name maps to a catalog carrier. A bare brand ("DPD Group") maps only when the number
  leaves one of its catalog networks (a DPD depot range picks DPD Switzerland or
  France); routing then confirms it with that carrier's adapter. The rendered page's
  per-scan carrier names give the same hints. The carrier and service ParcelsApp names
  "url", its link to another tracker, are left out.
- A number ParcelsApp names next for the parcel (`next_tracking_ids`, "Next tracking
  numbers" on its page) becomes `delivery_tracking_number`, with its carrier as
  `delivery_carrier`, when the carrier of the newest scan is a catalog carrier whose own
  rule claims it, a bare brand resolved by that number: a line's parcel that DPD Poland
  carries on names DPD Poland's waybill next. The tracker then asks that carrier's own
  adapter, which keeps the parcel's last leg direct when no tracker serves the line. A
  number of a carrier with no later scan, such as an earlier leg's, or two such numbers,
  name no partner.
- The destination country the reply names (`destinationCode`, else a `destination` that
  is a country name) becomes `destination_country`, which routing uses to propose the
  destination's post for a postal number. A country only read off a reference ("CNPRT")
  dates scans but is not reported. Sender and estimate fields are not kept, and neither
  are ParcelsApp's `Estimated delivery` rows, a forecast dated ahead of the read. Nor is
  GEODIS Poland's "Transferred Data" under "Pekaes": its tracker's summary before the first
  scan, which ParcelsApp dates ten minutes after each of its reads.

## Limitations

- A change that moves a scan's instant gives it a new event id. No identity policy can
  relabel it: ParcelsApp's dates are UTC and carry no code. The app leaves out a scan moved
  by whole quarter hours, up to 14 hours, with the same wording, as a copy of its stored
  row, so nothing is stored or announced twice. That row keeps its old instant until a
  re-key, and a scan moved any other way gets a row of its own. A scan that loses its
  instant, now kept as a wall clock, leaves its stored row as it was.
- Postcode unlock is unverified. For an invalid postcode, SEUR and bpost repeat
  `require_fields` instead of returning an explicit error, both in the real form and via
  HTTP. Verifying the unlock needs a known valid number and postcode pair.
- Rate limit. On 2026-10-10 ParcelsApp blocked an address after about 145 lookups in 40
  minutes, three or four a minute, most of them for numbers it had not cached. From then on
  it answered every lookup from that address with an instant `{"error":"NO_DATA"}` and
  HTTP 200, for any number, on the website too. The block still held four hours later.
  Another network got answers, and so did the production server, at a few lookups an hour.
  The adapter cannot tell this answer from a real one, which is one reason `NO_DATA` stays
  inconclusive.
- Test with the adapter, not curl. The same day, curl from the production server got
  `NO_DATA` for a parcel the adapter fetched from that server and address minutes
  earlier, with the same body and User-Agent, over HTTP/1.1 and HTTP/2.
- Email, phone, house-number, sign-in and country-selector forms are not supported.

## Rejected approaches

- Plain GET of the tracking page: returns the application shell only.
- The API-key client (`locky42/parcels-app-provider`): needs a provisioned key.
- Browser-only lookups (as in `thefuga/parcelsapp-crawler`): slower, and unnecessary.
- Retrying an empty answer in the caller's country through the website's country selector
  (`extra[manualCountry]`; the top-level `country` alone selects nothing): it recovered no
  history in a host's lookups, and spent a request each time.

## Testing

`npm run test:carriers:live -- providers/parcelsapp` with
`PARCELSAPP_LIVE_NUMBER` set, and optionally `PARCELSAPP_LIVE_POSTCODE`,
`PARCELSAPP_LIVE_EXPECTED_STATES` and `PARCELSAPP_LIVE_EXPECTED_EVENTS`. Keep live
values out of the repository. Unit tests use synthetic
[fixtures](fixtures/README.md) and never contact ParcelsApp.
