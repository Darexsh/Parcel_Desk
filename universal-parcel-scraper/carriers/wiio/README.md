# Wiio

Tracks parcels of Wiio, formerly Sumai, a Hangzhou dropshipping platform, on the tracker of its
own line, PD Express (蓬达, Hangzhou Pengda Technology), a tenant of the Hualei (华磊) forwarder
platform. PD Express hands parcels to the destination's carriers. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
clocks and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.hzpdex.com:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The line's own rows come to the second on the platform's Beijing clock and are read on it.
  The rows it copies from the airline and the delivery carrier come to the minute on their own
  clocks and stay `local_time`: on Beijing time, a delivery in the United Kingdom at 13:20 would
  fall before six in the morning there.
- Once the delivery carrier has the parcel, the record's tracking number is that carrier's. It
  is returned as `delivery_tracking_number`, without a delivery carrier: the record names no
  channel.
- The record's product name is the service name.

## Limitations

Rows the status map does not list are staged from their wording by the shared language rules. A
platform row that falls on a whole minute reads as a wall clock.

## Numbers

A store owner's post shows ZLX, two letters, ten digits and two letters, and PD Express's tracker
answers it. It is one sample, so the rule is low, and recognition asks the tracker.

## Links

The tracker is HTTP only, so the catalog opens Wiio's site. A tracker link opens the number from
its `documentCode` parameter.

## Testing

`npm run test:carriers:live -- carriers/wiio`, with `WIIO_TRACKING_NUMBER` and optionally
`WIIO_UNKNOWN_NUMBER` set outside the repository.
