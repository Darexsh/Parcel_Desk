# PostNord

Tracks individual parcels through the anonymous JSON service used by PostNord's official tracking widget.
Døgnposten, Post Danmark's parcel-locker brand, carried PostNord numbers, so its name counts as PostNord's.

An SSCC typed with its 00 identifier is suggested with PostNord first when it
carries a Danish (57) or Swedish (73) GS1 prefix and its check digit passes.
Bring stays first for its 00370 and 00373 parcels, Early Bird for SSCCs under its GS1 company
prefix, and those and Norwegian and Finnish prefixes keep PostNord among the other candidates. Several carriers share
twenty digits, so recognition asks PostNord through the same lookup.

Mail from abroad reaches PostNord when a caller names it, a provider names it, or a
result gives Sweden or Denmark as the destination of an S10 item. Pasted links carry the
number as `id` on `tracking.postnord.com` and as `shipmentId` on the national sites'
tracking pages.

## How it works

One GET returns the shipment and scans. The request carries the widget's bounded SHA-512
nonce proof and tracking-site origin. Both are required: an incomplete request can look
like a missing shipment. Only the service's structured not-found response is a clean negative.

## Notes

The requested identifier must match the shipment, selected item and returned identifier.
Shipment group references and aliases need an exact item reference. Offset timestamps
are ordered by instant; incomplete scans fail rather than allowing older progress to appear current.
A scan PostNord has by EDI and gives only a country (`locationType` UNDEF), to the minute, can
be that country's wall clock under a Z. PostNord's own relays and the origin post's are: a
Danish item's scans came two hours after its postcentre's, and Poczta Polska's posting two
hours after Poczta Polska's own instant. They are read on the country's clock, or keep their
wall clock in a country of several, and a twin labelled with the instant counts once. A post
delivering abroad relays instants (Deutsche Post's have the minute of its own tracker's), and
without a destination a foreign post's scan stays as labelled. A terminal's own scans carry
milliseconds; one it has to the minute (`locationType` HUB) is its wall clock too: an airport
terminal's scans of mail from abroad were answered before their labelled UTC time.
Each event uses its own code and, where the code covers several milestones, exact portal wording.
The parcel app's review asks the same map (`statusMap`); a copy without a code gets a stage only
from wording that names a milestone or a hold of its own.
Pickup availability remains distinct from parcel delivery. Confirmed notification and
recipient-choice notices, a chosen pickup point among them, are omitted from shipment
history, so a delivered message cannot become a parcel-delivery milestone. A notice-only
response is inconclusive.
Summary status comes from the selected item's current status. EN_ROUTE's heading, "The shipment
item is under transportation", labels every milestone of the code, so under it the newest scan
names the stage. A drop-off by the sender, even after the day's last collection, reads as
accepted. Customs clearance and a hold for a booked delivery are not exceptions. The sender the portal names, usually the shop, the
destination country and the shipment's `serviceName` are kept. Recipient names and addresses,
sender references, delivery instructions and proof data are excluded.

A parcel waiting at a service point gets that point as its pickup point: the shipment's
`servicePoint` record, which the widget shows under a parcel ready for pickup, gives its
name, street, then postcode and town. Without it, the name the scan gives stands alone.
A parcel collected there keeps the point when the delivery, scanned at the same point,
directly follows its arrival there. The reply no longer carries the record once the
parcel is collected, and scans name the point without an id to look it up by, so a
collected parcel keeps only the name.

## Testing

`npm run test:carriers:live -- carriers/postnord` checks a structured negative.
Set `POSTNORD_TRACKING_NUMBER` to check history for an authorized real parcel.
