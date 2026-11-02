# Packlink

Packlink sells shipping with other carriers, such as Correos Express, SEUR and UPS, from its
consumer site and from Packlink PRO for businesses, in Spain and other European markets. Its
reference names the booking; the carrier that collects the parcel gives it its own number.
Tracked through the lookup its tracking pages make.

## How it works

1. `direct`: one `GET https://api.packlink.com/v1/trackings/{reference}`, as the tracking page
   sends it. It needs no cookie, token, key or browser. The JSON reply has the shipment's
   milestones and, for each parcel, the collecting carrier's number and the scans Packlink read
   from that carrier, oldest first.
2. `retry`: one more try when the request fails to reach the API or hangs. The first try gets
   half of the budget.

- The lookup takes only the Packlink reference, in capitals, so the reference is sent in
  capitals.
- An unknown reference is HTTP 404 with `{"messages":[{"message":"Not Found"}]}`. A 404 without
  a body or a redirect is a moved route.
- The shipment must echo the reference asked.
- Recognition makes the same request.

## Notes

- Each scan carries Packlink's own code and the collecting carrier's label. The label is the
  description, else Packlink's English wording for the code, and the code is the provider code.
- Packlink's offsets hold for some collecting carriers and are hours off for others, so a scan
  keeps only the wall clock the page shows a visitor in Spain, as `local_time`. Packlink's own
  milestones, read only while no parcel has a scan, are instants of its own clock.
- Packlink files some scans under a family's catch-all code that the label contradicts, such as
  a depot's receipt under `READY_FOR_COLLECTION` or a notice that the parcel has yet to reach
  the destination depot under `OUT_FOR_DELIVERY_INCIDENT`. Under those codes the label stages
  the scan, then the family. `DELIVERED_02` is a parcel waiting at a pickup point.
- Notices that Packlink stopped following the carrier or found nothing yet have no stage.
- Parcels of one shipment usually repeat the same scans, which are kept once.
- The reply names the carrier's number but not the carrier, so `delivery_tracking_number` is
  the shipment's number, else its only parcel's, and the number's own detection decides any
  hand-off.
- Places are not kept: one shipment can carry the same town on every scan. Phone numbers and
  e-mail addresses are removed from the labels. The page's public tracking id is not kept.

## Limitations

- No collecting carrier's name, weight, service, location, sender or recipient.
- The carrier's own number is not answered; it is tracked through its own carrier.
- Packlink forgets older bookings, which then read as not found.

## Numbers

A Packlink reference is 19 characters: two letters for the market, the four-digit year, `COM`
for the consumer site or `PRO` for Packlink PRO, and ten digits. Packlink's help centre and its
open-source shop modules print that layout, and no other carrier's rule takes it, so the rule
has high confidence. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

No address that opens one shipment is known, so no portal link is published. The search box on
Packlink's tracking pages sends the text typed to the same lookup.

## Testing

`PACKLINK_TRACKING_NUMBER=... PACKLINK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/packlink`
