# Jiuhao International

Tracks shipments of Jiuhao International (广州九好国际货运代理有限公司, JHGJ on 17TRACK), a
Guangzhou forwarder, on its own tenant of the Hualei (华磊) forwarder platform. The client is
shared with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps
its host and status map, and reads the places inside its rows itself.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `119.29.157.172:8082`, the address the parcel search on the company's site posts to, then,
   when the interface holds no row for the number, one POST of the same `documentCode` to the
   tracking page `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed, and no portal link is published. The company site at `jiuhaowuliu.com`
answers only from China, and the adapter never visits it.

## Notes

- An order's rows are written when it is created, dated ahead, from the collection in
  Guangzhou to the delivery round; the delivery row comes later, written after its clock. A row
  written more than twelve hours before its own clock is a forecast, not a scan, and is held
  back, as is a row dated after the lookup on Beijing time. An order whose rows are all held
  back has no history yet. The record's own summary status is not read.
- Scan times are wall clocks without an offset and stay `local_time`. The rows written ahead
  follow the tracker's Beijing clock, as [GZYL's](../gzyl/README.md) do, but the delivery row
  reads as the destination's clock: on Beijing time it would put a delivery before six in the
  morning there. One history mixes zones, so no row gets an offset.
- Rows from China carry their place in brackets (`航空公司接收【Hong Kong】`). Destination rows
  add the recipient's town and postcode after the wording. [parser.ts](parser.ts) splits the
  place from the wording and keeps the town; the postcode is dropped.
- The record's product name is the service name.
- The same server hosts the site of another Guangzhou forwarder, 广州务必达国际物流, which links
  to this system too. The waybills, products and customer accounts in it carry Jiuhao's
  initials.

## Limitations

The records name no delivery carrier or its number, so there is no hand-off. A reference stored
without its dashes is not found.

## Numbers

Jiuhao's waybills are JH, ten digits and CN, made by a Hualei number rule; JH is 九好's
initials, and 17TRACK files the shape under Jiuhao. JH fits other companies' initials too, so the
rule has low confidence and recognition asks the tracker. The shape is one character longer
than an S10 postal number. The tracker also accepts the shipper's reference, which no rule
claims. No public number has been found, so the corpus holds a synthetic one.

The Kingtrans tenant at `jhgj.kingtrans.net` belongs to 广东嘉华物流, not to Jiuhao, and does
not know these parcels.

## Testing

`npm run test:carriers:live -- carriers/jhgj`, with `JHGJ_TRACKING_NUMBER` and optionally
`JHGJ_UNKNOWN_NUMBER` set outside the repository.
