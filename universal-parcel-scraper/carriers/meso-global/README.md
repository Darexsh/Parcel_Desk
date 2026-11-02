# Meso-global

Tracks shipments of Shenzhen Zhongji Cross-border Supply Chain (深圳市中际跨境供应链有限公司), a
Shenzhen forwarder that brands itself Meso-global and whose site is mesoglobal.cc, on its own
tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.mesoglobal.cc:8082`, which the site's tracking form posts to, then, when the interface
   holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The status map lists the Chinese rows universal providers relay from the tracker, from the
  shipment data to the hand-over at the delivery carrier's depot, with the English the adapter
  shows for them, and DHL Germany's English rows that follow. Flight rows name the day they
  expect the flight as month-day; the map reads them without it, and the English leaves it out,
  since it is still to come. The hand-over row starts with a month-day too, read the same way.
- Scan times are wall clocks without an offset on the platform's Beijing clock and are read on
  it; a row dated after the lookup is held back.
- 17TRACK names the forwarder Meso-global, and its Chinese name 中际跨境; both are names here.

## Limitations

Universal providers relay a DHL leg on a line to Europe, but no public reply shows
whether the tracker's record names that channel or its number. No public number has been found,
so the reply's fields are known from the platform.

## Numbers

Its numbers are ZJKJ, the initials of its Chinese name 中际跨境 (Zhongji Kuajing), and ten digits. A
parcel the app tracked has that layout and Meso-global's tracker answers it, and no other carrier's
rule takes it, so `meso-global-1` has high confidence. No public page shows a whole Meso-global
number, so the corpus holds a synthetic one.

## Links

A link to the tracker's page with the number in its `documentCode` parameter names Meso-global.

## Testing

`npm run test:carriers:live -- carriers/meso-global`
