# Xinghe Freight

Tracks shipments of Xinghe Freight, 星和货运 (广州星和货运代理有限公司, Guangzhou Xinghe Freight
Forwarding), a Guangzhou forwarder whose site is xinghe-express.cn. Universal providers name it GZXH.

## How it works

The site's tracking form opens `trackIndex.htm?documentCode=` on the Hualei (华磊) tracker at
`134.175.243.207:8082`, over plain HTTP. That is [GZYL's](../gzyl/README.md) tenant, so the
adapter is GZYL's with this carrier's id: the same requests, steps and not-found answer
([hualei.ts](../gzyl/hualei.ts)).

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

## Notes

- The rows universal providers relay for a GZXH parcel are GZYL's own wordings, so GZYL's status
  map reads them, and its splitting of a town written after a wording gives the place.
- A not-found leaves the enabled universal providers to answer.

## Limitations

No public reply has shown a Xinghe Freight waybill on the tracker; its coverage rests on the
site's tracking form and the relayed wordings. HTTP recognition does not ask it.

## Numbers

No public source shows a whole Xinghe Freight number. A parcel a universal provider files under
GZXH has `GZXH`, ten digits and `YQ`, the layout of forwarders on the Hualei platform, which
open their waybills with their own code; the corpus holds a made-up number in that shape. `GZXH`
is the company's code, the one universal providers file it under, so the rule names Xinghe
Freight with high confidence.

## Links

No portal link is published, since a plain-HTTP link would leave the number in the clear. The
canary takes HTTPS only, so it checks 17TRACK, not the tracker.

## Testing

Set `XINGHE_FREIGHT_TRACKING_NUMBER` (and `XINGHE_FREIGHT_UNKNOWN_NUMBER` for the not-found
answer) outside the repository and run `npm run test:carriers:live -- carriers/xinghe-freight`.
