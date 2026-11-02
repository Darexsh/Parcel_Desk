# DPD Germany

DPD parcels tracked through the German business unit. DPD Switzerland remains
[dpd](../dpd/README.md), and DPD France is [dpd-fr](../dpd-fr/README.md).

## How it works

1. `app`: the SOAP service of the German
   [DPD app](https://play.google.com/store/apps/details?id=de.dpd.mobile) at
   `https://api.paketnavigator.de/services/v1/Navigator3Service.asmx`
   ([service schema](https://api.paketnavigator.de/services/v1/Navigator3Service.asmx?WSDL)),
   over plain HTTP. Without a postcode it runs first, because its scans name
   their facility and include order registration, where the unverified guest
   reply has neither.
2. `direct`: the myDPD guest API, using `businessUnit=DPD-DE`. It shares the
   installation, Remote Config and OAuth protocol with the Swiss adapter.
   Tokens are cached per instance; all requests share the caller's deadline
   and cancellation signal. With a postcode it runs first, because DPD then
   verifies the reply and adds places and the delivery window; the app service
   follows it, with the same postcode.
3. `abroad`: a parcel either service places in another country, which the other
   service is not asked about. DPD's group-wide guest service, asked through
   Belgium's unit as for [DPD Ireland](../dpd-ie/README.md), and that country's
   DPD unit when it has a source of its own, asked together: Belgium's, the
   Netherlands' and Switzerland's read the group's service. The unit's history
   answers when it holds more scans and is not behind the group's milestones,
   else the group's milestones, as a truncated history. Either answers when the
   other fails, and the answer keeps the link of the source that gave it. No
   unit opens a browser: DPD France's and Portugal's pages use direct HTTP. A
   unit's clocks without a zone are dated as its own lookup dates them, so DPD
   Portugal's scans, which name no place, are on Lisbon's clock rather than
   Germany's. Scans an earlier release dated on Germany's clock keep their rows
   (`matchWallClock`).

Either German service answers when the other fails, except for a parcel the
guest API does not know (a 404, or a 400 typed `PARCEL_NOT_FOUND` without a
postcode, as for [Switzerland](../dpd/README.md)) or one placed in another
country.

## Notes

- Both the requested number and returned parcel identity must match.
  Empty history is inconclusive; malformed or undated events are schema errors.
- A delivery postcode is optional. Both services check it against the
  recipient's. A rejected postcode gets one unverified lookup, and
  `dpd_postcode_verified` says which. Unverified guest replies omit places and
  the delivery window.
- The group API knows parcels across countries, and a parcel registered with
  DPD Germany can be delivered by another unit. Its current country decides
  where it is read: Germany through the German services, another country in
  the `abroad` step.
- Recognition asks the guest API without a postcode, as DPD Switzerland does,
  and knows a number only when the parcel's current country is Germany. Another
  country is unknown, and a reply without a country is inconclusive. The app
  service is not asked: a cold session takes tens of seconds to open.
- Scan offsets take precedence over local clocks. Germany and Switzerland
  share the same civil-clock rules for the supported tracking history.
- Each answer comes from one service, so a consumer can store one parcel's
  scans from both. The app service dates a scan to the minute, the guest API
  to the second, up to a minute apart, in other words, and only the guest
  API's scans carry DPD's code. The identity policy (`identity.ts`) lets a scan
  from one service take over the other's stored row for it: the same stage,
  less than a minute apart, the same place or none, and the match unique both
  ways. The guest API's hand-over, "Parcel handed to DPD", is the first
  depot's scan the app calls "In transit.", and the two match whatever stage
  each reads.
- The Swiss page fallback is not used for German lookups.

## App service

`getSessionFullState` opens an anonymous device session, `getTrackingData`
binds the whole parcel number and gives the progress rail,
`getTrackingScanList` supplies the scans, and `getParcelShopByID` gives the
address of the shop holding the parcel. Each call carries the app's partner
name and token with a `KeyPhase` derived from its partner password, the
operation and the minute of the UTC day. These credentials are compiled into the
app, the same for every install and independent of any account, and are
included in the adapter. The app also sends a Firebase App Check token, which
the service does not require. The client is in [service.ts](service.ts), shared
with [DPD Switzerland](../dpd/README.md), whose Pickup shops
`getParcelShopByID` also knows.

- The service takes tens of seconds to open a session, whatever the device
  data, language or user agent. Sending a session's token back to
  `getSessionFullState` takes as long and returns another token. The reply
  gives no expiry. The service has accepted a session for over two days, used
  once an hour after its first eight, and one left idle for four. It refused
  another at twenty-seven hours old, in two checks an hour apart. While slow,
  it can refuse a session that it accepts again later.
- One session serves the process for each transport and user agent, shared by
  DPD Germany and DPD Switzerland and by the adapters of every registry and
  tracker. A tracker's own fetcher only adds each lookup's signal, so the
  session is that of the fetcher the host gave it. It serves, whatever its
  age, until the service refuses it.
- Lookups share the opening, which can take two minutes and runs while a
  lookup that asked for it is still running. Ahead of the guest API, a lookup
  waits for it while keeping 20 seconds for the guest API, and asks the guest
  API meanwhile, also when the service refused the session it had, but not
  while a host's store gives back its sessions. A parcel the guest API does
  not know, or places in another country, ends the wait at once. Otherwise the
  lookup keeps waiting: the unverified guest reply has one entry per
  milestone, without places, registration or repeated delivery attempts, and
  its clocks and wording differ from the app's scans, so a consumer that
  stored both would keep each scan twice. The default budget leaves time to
  wait, so the first lookup of a process lasts as long as the opening, and the
  guest API's reply answers if the session does not open in time. A lookup
  with less budget goes on to the guest API at once, and the opening continues
  until that lookup's budget ends.
- A long-lived host calls `warmDpdSession()` from `universal-parcel-scraper/node`
  at start, with the `fetcher` and `userAgent` it gives `createTracker` or its
  adapter environment, if it sets them. The session then opens in the
  background and stays open: openings run to their end without a lookup, the
  next one opens once the service refuses the session, and a failed one is
  tried again a quarter of an hour later. The timers do not keep the process
  alive.
- The host can also pass a `DpdSessionStore` as `{ store }`, which loads and
  saves `DpdSession` records. At start, the newest saved session is taken up
  again, whatever its age, instead of opening one; lookups wait up to five
  seconds for the store. The current session is then checked once an hour
  with a shop id no shop has: the service answers it without a shop, or
  refuses the session, which opens the next one at once rather than when a
  lookup meets the refusal. Each session lookups stop using is checked once an
  hour too, until a check repeats a refusal, and for a week after it opened.
  A restart checks each session an hour after its saved `checkedAt`, or at
  once if it has none, so frequent deploys do not hold checks back. Each
  acceptance is saved as `checkedAt`, and a refusal the next check repeats as
  `refusedAt`: `checkedAt - openedAt` is how long the service has accepted a
  session, and `refusedAt - openedAt` how long it accepted one it refuses.
  Checks of several sessions are five seconds apart. A failing store leaves lookups as
  they are without one, once it has failed: one that does not answer holds the
  lookups that arrive meanwhile for those five seconds, and only then do they
  ask the guest API.
- An `onSession` observer in the same options hears of each session: a
  `DpdSessionEvent` when a saved one is taken up at start (`taken_up`, with
  its `ageMs` and the store's load time as `durationMs`), and when an opening
  ends (`opened` or `failed`, with its `durationMs` and, for a failure, an
  `errorKind`). Its `trigger` says what began the opening: `start`, `retry`
  after a failed one, `refused` after a lookup or a check found the service
  refusing the session, or `lookup` when a lookup found none open. It never receives a token, runs
  apart from lookups, and what it throws or rejects is ignored.
- `getTrackingData` and `getTrackingScanList` take the postcode as
  `DeliveryZipCode`. A matching one returns `DataViewStatus`
  `DeliveryZipCode_isValid`; a wrong one, or any postcode for an unknown parcel,
  returns `ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID` with the anonymous view.
  For a delivered parcel, the verified view adds only the recipient's name and
  driver tip details, which are not read.
- `UpdateNewDeliveryData` and `addParcelIfNoTrackingdataAvailable` stay false,
  so a lookup changes nothing in the session.
- The recipient address reads Germany for parcels delivered in other
  countries, with or without the postcode. The current country is the newest
  scan's, else the country of the last status's depot; an unknown depot has a
  three-letter placeholder.
- Scans carry English wording without codes. Each known wording is mapped
  whole in [status.ts](status.ts), because the shared classifier misreads
  several of them. A collection the sender booked is still registration; the
  recipient's collection from a Pickup station or shop is the delivery. DPD
  words a driver's collection from a shop, and the shop's note that no
  recipient collected the parcel, the same for a parcel the sender dropped
  there as for one its recipient left: after the parcel waited at the shop for
  its recipient they start the return, otherwise the driver takes the parcel on
  and the note moves nothing. Its `statusMap` answers for both services: the
  app's scans by wording, the guest API's by DPD's codes, and leaves those two
  scans without a stage. A return names itself in its scans:
  it stays an exception under way and becomes returned at the sender, and the
  progress rail's return state keeps the result in the exception status. An
  announced delivery day is read as an estimate, without becoming a scan or
  changing tracking freshness.
- Estimates use the flagged live delivery window, a specified planned date,
  or a fully dated announcement. A changed planned date replaces the previous
  window, as in the app. Placeholder dates, incomplete windows and display
  dates without a year are ignored; completed delivery and pickup availability
  clear the forecast. Offset-bearing windows use German civil time; unresolved
  window clocks retain their supplied digits.
- Scan clocks have minutes and no offset. A scan at a German facility is read
  in German civil time, which agrees with the guest API's offsets for the same
  scans. A clock elsewhere stays local.
- The scans name their facility's town and country without a postcode, and
  include order registration before the first guest API event. A parcel shop
  or locker scan also names the shop and its PUDO id. While the parcel waits
  there, the shop becomes the pickup point: its name, then its street and its
  town on their own lines. The address comes from `getParcelShopByID` for that
  PUDO id and must name the same one. Without it the name stands alone. The
  shop's phone, opening hours and coordinates are not read. A delivered parcel
  has none, collected there or not.
- The order's measured length, width and height are in millimetres. A side of
  zero means no measurement, and the shipper's declared size is not read.
- The service reports "no tracking data" for parcels its scan list still
  knows, so that answer is inconclusive. A parcel placed outside Germany goes
  to the `abroad` step.

## Limitations

Recipient details and addresses, delivery proofs and preference links are discarded.
No UK service is inferred from a German result. The app service's reason codes
and driver details are not projected. The app service does not name the sender,
nor does the guest API's unverified reply. An estimate requires a forecast in
DPD's reply. A delivery postcode can unlock the guest API's window.

## Numbers

Parcels carry DPD's fourteen-digit parcel number, whose first four digits are the issuing
depot, and labels add a check character. [Paketda's DPD label guide](https://www.paketda.de/dpd/dpd-paketlabel.php)
reads the depot of the sender's region there, and its [list of DPD depots in Germany](https://www.paketda.de/paketdepot-dpd.html)
numbers them 0101 to 0199, with two more in the 0200s. `dpd-de-3` and `dpd-de-4` claim fourteen
digits opening with 0101 to 0199, with or without the check character, at low confidence and
list DPD Germany first, as the Austrian and Swiss rules do for their depots. Recognition asks
DPD Germany first wherever the parcel is looked up; it knows only a parcel in Germany, so a
parcel delivered by another network is left to that network. Other fourteen-digit numbers stay
with the DPD entries' shared rules. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/dpd-de`. Set
`DPD_DE_TRACKING_NUMBER` outside the repository for a positive lookup through
each tier and its recognition, and `DPD_DE_POSTCODE` to check the app's
postcode verification.
