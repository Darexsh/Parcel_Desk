# Mayi Yinfu

Tracks shipments of Mayi Yinfu (广东蚂蚁银服国际物流有限公司), a Guangdong forwarder of express and
small parcels from China, on its own tenant of the Hualei (华磊) forwarder platform. It flies
parcels to the destination region and hands them to a delivering carrier, such as Deutsche Post
DHL into Europe. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform; this carrier keeps its host and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.mayiyinfu.com.cn:8082`, then, when the interface holds no row for the number, one POST
   of the same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- After the hand-off the tracker copies the delivering carrier's scans into its own history,
  in that carrier's English wording, so the history ends with DHL's rows. A copied row can end
  with the destination operator's tracking link in brackets; the map reads the wording before it.
- Mayi Yinfu's own rows mix Chinese and an English translation. Flight rows lead with the step
  (`货物已交机场`, `头程起飞`, `航班延误`), then the day the next one is expected and the
  translation; [status.ts](status.ts) reads the step when the whole row is not in the map. The
  day is still to come, so such a row shows the English of its step alone, the `english` of its
  entry in [statuses.json](statuses.json); a row stored with the day is taken over by it at the
  same instant and place ([identity.ts](identity.ts)).
  `货物已交机场` is a hand-over to the airport and stays in transit, though its translation
  reads "delivered".
- Rows coded `CO_C_CR` come from a scripted track: they can report the departure, the arrival
  and the clearance before the forwarder's own rows have the parcel at the airport. They are no
  scans and are held back, as on every tenant ([GZYL](../gzyl/README.md)).
- Scan times are wall clocks without an offset. The tracker writes the scans it copies from DHL
  on its own Beijing clock: DHL's own offset times for them are the same instants. Once DHL takes
  the record, a copied row whose place is a country code is read on Beijing time, wherever DHL
  scanned it, and so is a row at a place in China, where the place's clock and the tracker's
  agree. DHL's rows without a place have also come on DHL's German clock, and the forwarder's own
  rows abroad could be on either clock, so they keep their wall clocks in `local_time`. The newest
  row's instant, when it has one, is the last update, and the delivery's when it is the newest
  row. A row dated after the lookup on Beijing time is held back.
- The forwarder's rows can give Shenzhen as `SZ`, which as a code is Eswatini. A row whose place
  is only `SZ` has no place, so its neighbours date it rather than Eswatini's clock.
- The record's product name is the service name.
- Records name no channel, but carry the delivering carrier's number as the channel's transfer
  number. Into Europe that is a Deutsche Post DHL parcel number, and DHL's tracker follows the
  parcel to its delivery abroad, with offset times. So DHL takes the record when its own
  high-confidence rule claims the whole transfer number. Another carrier's number hands nothing
  over, since an issuer does not prove who delivers.

## Limitations

A reference stored without its dashes is not found. A transfer number that no DHL rule claims
with high confidence hands nothing over.

## Numbers

Its tracking numbers are MY, ten digits and US, MY standing for 蚂蚁 (Mayi). The suffix does
not name the destination. The shape is fixed and no other carrier's rule takes it, so the rule
has high confidence. The tracker also accepts the shipper's reference, which no rule claims. No
public number has been found, so the corpus holds a synthetic one.

## Links

`www.mayiyinfu.com.cn:8082/trackIndex.htm?documentCode={number}` opens one parcel on the
carrier's tracker. Since it is plain HTTP, no portal link is published.

## Testing

`npm run test:carriers:live -- carriers/mayiyinfu`, with `MAYIYINFU_TRACKING_NUMBER` and
optionally `MAYIYINFU_UNKNOWN_NUMBER` set outside the repository.
