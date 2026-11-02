# Yilong Logistics

Tracks shipments of Yilong Logistics (一龙物流, 莆田市城厢区一龙物流有限公司), a Chinese
forwarder whose site is yxhlexpress.com, on its own tenant of the Hualei (华磊) forwarder
platform. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform; this carrier keeps its host and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.yxhlexpress.com:8082`, then, when the interface holds no row for the number, one POST
   of the same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed, and
no portal link is published: the site's own search form posts to an ASP.NET page that needs its
view state, so the adapter reads the Hualei interface behind it instead.

## Notes

- The forwarder writes its scans in English: warehouse receipt and departure, export clearance
  and the hand-over to the airline. Only the warehouse rows carry a kind code (`ARRIVAL`,
  `SHIPMENT`) and a place; the stage comes from the wording in [status.ts](status.ts).
- Scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held
  back.

## Limitations

The record names no delivery carrier or last-mile number, so tracking stops at the airline
hand-over until the forwarder adds rows.

## Numbers

Yilong Logistics' waybills are YIL, nine digits and WL. The prefix is the forwarder's name and
no other carrier issues the layout, so the rule has high confidence. No public number has been
found, so the corpus holds a synthetic one.

## Testing

`npm run test:carriers:live -- carriers/yilong-logistics`, with
`YILONG_LOGISTICS_TRACKING_NUMBER` and optionally `YILONG_LOGISTICS_UNKNOWN_NUMBER` set outside
the repository.
