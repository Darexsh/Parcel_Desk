# Lingdong International

Tracks shipments of Shenzhen Lingdong International Freight Forwarding (领东国际,
深圳市领东国际货运代理有限公司), a Chinese forwarder whose site is lingdong56.com, on its own
tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `tms.lingdong56.com:8082`, then, when the interface holds no row for the number, one POST
   of the same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The forwarder writes its scans in English: its Shenzhen warehouse's arrival (`ARRIVAL`) and
  departure (`SHIPMENT`) rows, each with a place. The stage comes from the wording in
  [status.ts](status.ts).
- Scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held
  back.

## Limitations

The record names no delivery carrier or last-mile number, so tracking stops at the warehouse's
departure scan until the forwarder adds rows.

## Numbers

Lingdong International's waybills are SZLD and ten digits. The prefix is the forwarder's
Shenzhen and Lingdong initials and no other carrier issues the layout, so the rule has high
confidence. No public number has been found, so the corpus holds a synthetic one.

## Links

`tms.lingdong56.com:8082/trackIndex.htm?documentCode={number}` opens one parcel on the
forwarder's tracker, which its site links to. Since it is plain HTTP, no portal link is
published.

## Testing

`npm run test:carriers:live -- carriers/lingdong`, with `LINGDONG_TRACKING_NUMBER` and
optionally `LINGDONG_UNKNOWN_NUMBER` set outside the repository.
