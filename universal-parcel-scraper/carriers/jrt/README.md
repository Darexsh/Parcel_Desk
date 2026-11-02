# JRT

Tracks shipments of JRT (厦门今日通商贸有限公司, Jinritong), a Xiamen forwarder, on its own tenant
of the Hualei (华磊) forwarder platform. The client is shared with [GZYL](../gzyl/README.md),
whose README describes the platform; this carrier keeps its host and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `106.53.64.22:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed, and no portal link is published.

## Notes

- JRT's own numbers and shippers' references both find an order. Asked by reference, the result
  carries JRT's number as `canonical_tracking_number`.
- Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, and
  JRT's number, which still finds the order, is in none of its fields. A lone record then answers
  a JRT number, unless it carries another JRT number. The delivering carrier's number is the
  delivery number, never the canonical one.
- JRT's interface lists no row for an order without scans, under either number. The page shows
  the platform's own row, `货物电子信息已经收到`, on the order's creation time: the order is
  registered.
- JRT's own rows mix Chinese and an English translation, and the map reads each one whole. The
  airport row books a flight on a day it names in both halves; [status.ts](status.ts) reads the
  day as an ellipsis, and the row shows its English without the flight, which is still to come.
  `已交服务商` (handed to the delivering carrier) and `货物已交机场` (handed to
  the airport) stay in transit, though their translations read "delivered".
- JRT words its arrival, its departure and the platform's own row only in Chinese. They show the
  English the platform's other tenants give them, the `english` of their entries in
  [statuses.json](statuses.json), and the map stages them by either wording. A row stored in
  Chinese is taken over by its English at the same instant and place ([identity.ts](identity.ts)).
- Lines into Europe end with DHL. After the hand-off the tracker copies DHL's rows into its own
  history, in lower case English, and the record's tracking number is DHL's. It names no
  channel, so the parcel goes to DHL when DHL's own rule claims the number whole. The line into
  Ireland ends with FedEx, whose twelve digits no rule claims alone; its product names FedEx, so
  the parcel goes to FedEx when FedEx's detection offers the number. DHL's collection after the
  hand-off is transit, and its rows of a
  return, the refusal included, are returned: the delivery that follows is the one back to the
  sender.
- The line into the United States ends with UPS. The tracker copies UPS's rows in Chinese, and
  they show UPS's English. They come on UPS's wall clock at the scan's place: a delivery read on
  Beijing time would fall before dawn there. Rows in UPS's words or at a place in the United
  States keep their wall clocks, which the scan's state dates, or a neighbouring scan's for a
  row without a place. The flight row names its month and day, read as an ellipsis.
- On the line into Europe the tracker also copies DHL's rows in DHL's own English sentences
  without a place. Those come to the minute on DHL's wall clock where it scanned the parcel, the
  wall clocks DHL's own reply gives: DHL's rows from Germany (the sender's data, the parcel centre
  of origin, the export centre, the transport abroad) are read on DHL's German clock, and the others
  on the destination's. Read on Beijing time, each would sit six or seven hours before DHL's own
  row and show twice. A help link DHL adds to a row is left out of its text.
- Other scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held back.

## Limitations

A reference stored without its dashes is not found. A wording the map does not hold falls back to
the shared wording rules. Before the hand-off the record has no DHL number, so DHL's own tracker
cannot follow the parcel yet.

## Numbers

JRT's own numbers are JRT, ten digits and MM, made by a Hualei number rule; JRT is 今日通's
initials. The tracker also accepts the customer's reference, which the shipper chooses. References
made of UP and sixteen digits find JRT orders, but nothing shows that only JRT's shippers use the
shape, so `jrt-2` offers them with low confidence and recognition asks the tracker, which must
hold the whole reference. No public number of either shape has been found, so the corpus holds
synthetic ones.

## Testing

`npm run test:carriers:live -- carriers/jrt`, with `JRT_TRACKING_NUMBER` and optionally
`JRT_UNKNOWN_NUMBER` set outside the repository.
