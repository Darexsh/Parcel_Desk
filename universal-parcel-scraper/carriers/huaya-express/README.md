# Huaya Express

Tracks shipments of Huaya Yuntong International Freight Forwarding (华亚运通国际货运代理有限公司),
a Guangzhou forwarder that brands itself Huaya Express and whose site is hyytgz.com, on its own
tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `193.112.176.17:8082`, which the site links, then, when the interface holds no row for the
   number, one POST of the same `documentCode` to the tracking page `trackIndex.htm`, which
   settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed.

## Notes

- The status map lists the English rows universal providers relay from the tracker, from the
  warehouse scan in Guangzhou to the hand-over to the local carrier in the destination country.
- Scan times are wall clocks without an offset on the platform's Beijing clock and are read on
  it; a row dated after the lookup is held back.
- 17TRACK names the forwarder GZHY, which is kept as an alias.

## Limitations

The hand-over row names neither the local carrier nor its number, so tracking stops there unless
the record names a delivery channel. No public number has been found, so the reply's fields are
known from the platform.

## Numbers

Huaya Express's waybills are HYYT, twelve digits and GZ: the forwarder's initials, the ones in its
domain, and Guangzhou's. No other carrier issues the layout, so the rule has high confidence. The
corpus holds a made-up number in the shape of a parcel a universal provider files under the
forwarder.

## Links

A link to the tracker's page with the number in its `documentCode` parameter names Huaya Express.
Since the tracker is plain HTTP on a bare address, no portal link is published, and the canary
checks 17TRACK instead.

## Testing

`npm run test:carriers:live -- carriers/huaya-express`, with `HUAYA_EXPRESS_TRACKING_NUMBER` and
optionally `HUAYA_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
