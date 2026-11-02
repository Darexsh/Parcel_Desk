# Bring / Posten Norway

Tracks consignments, their pieces and S10 postal items, Norwegian or from
abroad, through the current anonymous consumer service. A consignment number
with several pieces is inconclusive; each piece's own number still tracks that
piece. Mail from abroad reaches Bring when a caller names it, a provider names
it, or a result gives Norway as the destination of an S10 item.

Norwegian S10 numbers select Bring. Parcel SSCCs starting 370 or 373, with or
without their 00 identifier, and 17-digit consignment numbers starting 70 are
suggested with Bring first when their GS1 check digit passes, except a 00 SSCC under Early Bird's
GS1 company prefix, which is Early Bird's; other carriers
share these lengths, so recognition asks Bring through the same lookup. Links
from the Posten and Bring tracking sites resolve to Bring, and a link naming one
piece of a consignment tracks that piece.

## How it works

One bounded GET reads the JSON route published by the
[consumer portal](https://sporing.bring.no/sporing/). The consignment or parcel
identifier must match exactly. A parcel's SSCC typed with its 00 identifier is
asked as the 18-digit parcel number, which the result reports. An item from
abroad is its own consignment: the reply counts no items and names the piece
by the number asked. This route is
separate from the authenticated
[developer API](https://developer.bring.com/api/tracking/).

## Notes

Current progress follows the latest significant scan identified by the portal,
which a newer delivery change notice can sit above. Notifications and delivery
changes remain in history without a stage. Return transport and completed return
use different codes. A parcel handed in after the day's deadline reads as
accepted; other deviations are exceptions. Per-scan offsets establish instants;
incomplete clocks remain local evidence.

The sender the portal names, usually the shop, the destination country and the
parcel's `productName`, the Bring service it travels under, are kept. The estimated
day is kept while the parcel travels and the portal marks the estimate available.

The pickup point is named while the parcel waits there, and after it is collected
there: the delivery, and the movement before it that made the parcel ready for
pickup, were both scanned at the unit the portal names as the pickup point
(`expectedPickupUnitId`). A parcel taken back out for delivery keeps none. The
reply gives the point's name, unit id and map link but not its address. The map
page the link opens loads each unit's visiting address under the same id, but
only as one large list of every unit in the country
(`/kort/_/service/no.posten.map/enonicUnits?country=…`), with no lookup by id,
so the adapter does not read it.

Status wording comes from public event and cause codes. Free-text descriptions,
addresses, pickup codes and proof images are excluded. Weight and dimensions have
explicit units. The consumer's negative response does not name the number, so
it remains inconclusive; the portal's not-found answer, JSON or the bare text
`NOT FOUND`, carries the reason `portal_not_found`, so a consumer can tell it
from an outage.

## Live test

Set `BRING_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/bring-posten/adapter.live.test.ts`.
Optionally set `BRING_UNKNOWN_NUMBER` to check the inconclusive absence response.
