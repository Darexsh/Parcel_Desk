# MeiHoo Pegasus

Tracks shipments of MeiHoo Pegasus, a Chinese cross-border forwarder whose site is jecship.com,
on its own tenant of the Hualei (华磊) forwarder platform. Its parcels leave from Hong Kong by
air for Europe. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform; this carrier keeps its host, status map and the reading of its delivery row.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `129.204.184.34:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, in GBK, on a bare address that can move; the site's
Waybill Tracking page links to it. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The forwarder writes its rows in English, without kind codes, from the order data and its
  Hong Kong operation centre through the flights, the destination's customs and sorting to the
  delivery. [status.ts](status.ts) maps them by wording; the row that names the destination
  town matches whatever town it names.
- The delivery row has no place of its own and leads with the recipient's town, province and
  postcode. Before a wording the map knows, the town and province become the row's place and
  the postcode is dropped.
- Scan times are wall clocks without an offset on the platform's Beijing clock, abroad too, and
  are read on it; a row dated after the lookup is held back.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivery carrier is handed over.
- The tracker also finds a parcel by the shipper's reference, and then names the MYH number.

## Numbers

Its waybills are MYH, nine digits and CN. A parcel a universal provider filed under MeiHoo
Pegasus has that layout, the carrier's own tracker answers it with the same scans, and no other
carrier's rule takes it, so `meihoo-pegasus-1` has high confidence.

## Links

Since the tracker is plain HTTP on a bare address, no portal link is published, and the canary
checks 17TRACK instead.

## Testing

`npm run test:carriers:live -- carriers/meihoo-pegasus`, with `MEIHOO_PEGASUS_TRACKING_NUMBER`
and optionally `MEIHOO_PEGASUS_UNKNOWN_NUMBER` set outside the repository.
