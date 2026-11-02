# CTT Portugal

The Portuguese postal operator, for its S10 numbers ending in `PT` and for mail from abroad
under the S10 number its origin post gave it. Tracked through the OutSystems data actions on
`appserver.ctt.pt` that back the public tracker. CTT Express (`ctt-express`) is a separate
carrier.

## How it works

1. `direct`: the whole OutSystems ceremony runs inside one step.
   1. Derive the tokens: `GET /CustomerArea/moduleservices/moduleversioninfo` for
      `moduleVersion`, then the module manifest and the `PublicArea_Detail` screen bundle for
      each data action's `apiVersion`. CTT rotates both on every frontend deploy, so they
      are never pinned.
   2. `POST …/PublicArea_Detail/DataActionGetObjectEventsByInputObjectCode` without a cookie.
      It answers `403 Invalid Login` and sets the `nr2Users` session cookie on that same
      response: the 403 is the bootstrap. The retry sends the cookie plus `X-CSRFToken` read
      from its `crf=` field. Only one retry; a second failure is `CttApiError`.
   3. If the reply says `hasModuleVersionChanged` or `hasApiVersionChanged`, re-derive the
      tokens once and replay.
   4. `Found:false` means either an unknown number or a backend outage. Only then is
      `DataActionCheckIPLocked` called to tell them apart: `NotFoundError` for a genuine
      miss with an explicit healthy response, `CttMaintenanceError` (a `MaintenanceError`)
      for an announced outage. Missing or malformed flags stay inconclusive.
   - Every request sends a browser `User-Agent`; Cloudflare answers error 1010 without one.
   - Transient HTTP failures get one retry within the lookup budget, including during
     bootstrap. Persistent failures keep their HTTP status, retry window and bounded
     diagnostics; HTTP 503 remains maintenance.

## Notes

- `Found:false` is never treated as not-found directly: that would hide outages behind the
  not-found cooldown. The maintenance check runs only on a negative, since a found parcel
  already proves the backend is up.
- `CttApiError` is an `IndeterminateError`: a broken ceremony proves nothing about the
  shipment.
- Only the integer `StateId` is mapped, never the localized Portuguese `State` text. It is
  also returned as `provider_code`. An unmapped `StateId` gets no stage and the sync records
  the raw wording. The app's review asks the same map by that code (`statusMap`); wording
  without a code stays open there.
- A timestamp's `Z` is no offset: the digits are the wall clock where the scan happened
  (`clock.ts`). The tracker is an OutSystems app whose DateTime values travel as UTC strings,
  and its page shows the digits unconverted in any browser zone. UPU's tracking has the same
  wall clocks for CTT's posting and dispatch, and 17TRACK reads them on Lisbon's clock
  (checked 2026-10-10).
  - A scan at an office of exchange (`PTLISA - …`) or one of CTT's own sites (`Centro
    operacional` or `C.O.`, `Loja CTT`, `Ponto CTT`, `(CDP)`) is on Portugal's clock. That is the
    Azores' for a postcode from 9500 or a town only the islands have, and Lisbon's otherwise.
  - On a parcel bound abroad (`RecipientCountryCode`), the destination post's events
    (UPU `EMD`–`EMI`, `EDA`–`EDH`) keep that post's wall clock: they are read in the
    destination's zone. When it has several they keep CTT's `Z`, the last guess: hours off,
    but the reply keeps its instants. CTT relays them unconverted: an Italian delivery
    comes at the Italian office's time.
  - On mail from abroad, the origin post's events (UPU `EMA`–`EMC`, `EXA`–`EXD`) keep that
    post's wall clock: they are read in the zone of the sender's country, else of the country
    that issued the number, unless the location names a Portuguese office or CTT site. An
    origin with several zones keeps CTT's `Z`.
  - On a parcel CTT Express hands over in Spain, a scan at one of its agencies (a six-digit
    code starting `00`, as in `009999 - (PL) …`) and the acceptance CTT records with no
    place up to a minute before it are on Madrid's clock: CTT Express's own tracker dates
    that arrival two hours before the digits CTT shows.
  - The shipment record CTT Express sends, which CTT places in Madrid, is on Madrid's clock.
  - Any other scan is CTT's, on Portugal's clock.
  - Ship24's, ParcelsApp's and 17TRACK's copies keep CTT's digits, so a location they relay
    takes the same clock: a CTT Express agency's scan is Madrid's there too.
  - Any other offset is taken as sent. Wall times sort among instants by their digits.
- The app identity policy in [app.ts](app.ts) requires the same instant and `StateId` before
  updating a stored scan. Its `relabelledFrom: 'UTC'` lets a scan on its own clock take over
  the row stored under CTT's `Z`, by wall clock, provider code and location, and its
  `matchWallClock` lets a scan read on another zone take over the row showing its wall clock.
- Event `Local` mixes depot codes and point names. It is kept as a coarse location and never
  refined into an address. A bare number, such as the Spanish post office code on the
  acceptance CTT relays from Correos, is no place and is dropped.
- Sender and recipient names, contacts and addresses are on the record but never read; a
  test asserts it. Only the recipient's country is read, for the clocks above.
- At most 20 events are returned, newest first.
- The user-facing link is the legacy `objectSearch.jspx?objects=` page: CTT links it from
  its own site and it survives `appserver` host changes.

## Rejected approaches

- Scraping the rendered `objectSearch` page: it is a JavaScript app with no history in the
  HTML.
- Pinning the version tokens and refreshing on failure: CTT deploys often enough that the
  pinned value would be wrong more often than right.

## Limitations

- No delivery estimate.
- Detection offers CTT only its own `PT` numbers. Mail from abroad reaches CTT when a caller
  names it, a provider names CTT, or a result gives Portugal as the destination of an S10
  item.
- CTT's numbers outside S10 stay with the universal providers.

## Testing

`npm run test:carriers:live -- carriers/ctt`. The unknown-number check needs
no env vars; set `CTT_DELIVERED_TRACKING_NUMBER` to also check a real delivered parcel, and
`CTT_INBOUND_TRACKING_NUMBER` for an item from abroad.
