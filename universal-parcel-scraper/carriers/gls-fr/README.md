# GLS France

GLS France last-mile parcels (door, ParcelShop, locker), tracked through the
public consignee endpoint behind `moncolis.gls-france.com`. Independent of the
GROUP service used by [gls-ch](../gls-ch/README.md) and [gls-de](../gls-de/README.md).

## How it works

`direct`: one `GET https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes/{number}`
with the portal's `Origin` and `Referer`. No session or token; 12 s timeout,
750 kB cap. An unknown valid-shaped number returns HTTP 404 with a "no command
found" body naming the complete requested code, which is a definite not-found.
A generic 404 or 410 means the endpoint is unavailable and stays a failure.
A request that fails to reach GLS, or hangs, is sent once more: until then a
request gets at most half of the time left, so the retry fits in the rest, and
the default budget holds two requests.

The parser:

1. requires the number to be echoed in `trackid`, `numeroalphaColis` or
   `numeroGp` (whichever matches the shape asked for); a mismatch is a schema error;
2. reads up to 500 events, dedupes on (time, location, code), sorts newest
   first and keeps 100;
3. takes the parcel status from `statutColis`, falling back to the newest event.

While the parcel waits at a shop or locker, a second `GET {consignee-ws}/api/v2/searchNode/{trackid}/{point}`
reads that point's record, as the portal does, under a short bound. While it waits
at its depot, `GET {consignee-ws}/api/v1/agency/{trackid}/{depot}` reads the
depot's the same way. Optional: if it fails, the parcel has no pickup point.

HTTP recognition uses the same French endpoint and identity check, without the
pickup point. Unsupported
numbers and definite not-found replies remain unknown; endpoint failures and
mismatched shipments remain failures. Shared GLS number shapes still require
this confirmation before they can identify the French network.

## Notes

- GLS France sends codes, never wording. The map in `status.ts` is the only
  status source, and the English descriptions are ours. Unmapped codes produce
  an event with no stage for the sync to classify.
- `DEL` is read like the official frontend: a rescheduled delay (`in_transit`),
  and a failed attempt only when the same event's `typeEvenement` is `LIV`.
  `statutColis: DEL` is checked against the newest event the same way. The
  app's review asks the same map by an event's code (`statusMap`), and leaves
  `DEL` open: the stored event does not keep its type.
- `REC`, a receipt at a GLS depot, is the parcel's acceptance only before it
  moved on. A depot receives it again on its way in and when a round brings it
  back, and those receipts are in transit.
- Timestamps come in three shapes on the same fields: ISO with or without
  offset, SQL-style wall clock, bare day. An explicit offset is honoured;
  everything else is read in `Europe/Paris`. Empty values arrive as year `0001`
  and are dropped. No single `core/time` policy covers this, so parsing is local.
- GLS France can enter a departure at its planned time, such as an evening dispatch dated the
  coming midnight. A scan dated more than five minutes after the lookup is held back until it
  is due (`plannedScans`).
- Locations are GLS facility codes (`FR0012`), not resolved to cities.
- The estimate is the day part of `dateTheoriqueLivraison`. It is dropped once the
  parcel is delivered, waiting for collection, or in exception: the portal then
  shows the scan's own day. When `deliveryDateReliability` is `0` the portal presents
  the same day as a latest date.
- The sender is `libelleExpediteur`, the label the portal shows as the sender.
- A delivered parcel's delivery time is its newest delivered scan's.
- While the parcel's status says it waits at a shop or locker (`LIP`, `LTP`, `LIK`,
  `LTK`), the pickup point is the record of the point its own `relaisGlsColis`
  names: its name, then its street and its postcode and town on their own lines, as
  the portal prints them. The record must name the same point and be a shop or
  locker; without a street or town the name stands alone. A neighbour who keeps
  parcels (`2501` ids) is a private person and is never asked for. Under
  `codeActionColis` 20, collection at the depot, no shop is asked for.
- While the status says the parcel waits at its depot (`PAQ`), the portal tells the
  recipient to collect it there with an ID, and the pickup point is the depot its
  own `lieuTheoriqueLivraison` names: its name, then its address lines and its
  postcode and town, as the portal prints them. The record must name the same
  depot. A shop the record still names is not read then.
- Both endpoints answer any point or depot under any parcel code, so the place comes
  only from the parcel's own record. Phones, opening hours and coordinates are not
  read. A delivered parcel has none, collected there or not.
- Not used: scraping `moncolis.gls-france.com` — the endpoint returns the same
  data as JSON.
- The parser reads an allowlist of fields. Address, signature, contact and
  instruction blocks are never copied; a test asserts none reach the result.

## Limitations

- The endpoint is undocumented and may change or start challenging requests.
- The adapter accepts 8 alphanumerics, 11 digits, or 12 digits whose last is a
  valid GLS check digit. A GLS parcel number is 11 digits, so a 12-digit number is
  looked up by its first 11 and, only if that is not found, once more as printed;
  either way the parcel is identified by its 11 digits.
- No weight or dimensions in the response, so those capabilities are not declared.
- The endpoint only keeps recent parcels: older numbers answer the "no command
  found" 404.

## Testing

`npm run test:carriers:live -- carriers/gls-fr` (no env vars;
checks the 404 for a valid-shaped wrong number).
