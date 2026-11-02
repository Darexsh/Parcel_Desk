# BYHD

Tracks shipments of BYHD (深圳市博益弘达物流有限公司, Boyi Hongda), a Shenzhen forwarder, on its
own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.byhd56.com:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on the forwarder's own domain, and its site opens it with a
form post. No account, key, cookie, CAPTCHA or browser is needed, and no portal link is published.

## Notes

- The page finds an order by BYHD's number but does not show it: the record shows the delivery
  carrier's number and the shipper's reference, and the BYHD number only comes back in the hidden
  `codes` field, where the form echoes the numbers asked one per line. The page shows one record
  per number echoed, so a lone record is taken for the number when the echo holds that number
  alone. The tracking number the page shows is returned as `delivery_tracking_number`, without a
  delivery carrier: the page names no channel.
- An order without scans shows the platform's own row in English, `The electronic cargo
  information has been received`: the order is registered.
- Scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held back.

## Limitations

A reference stored without its dashes is not found. BYHD's scans are mapped by their wording, in
English or Chinese; a row's kind code, such as `ARRIVAL`, groups several wordings and decides
nothing. Wording the map does not list falls back to the shared wording rules.

## Numbers

BYHD's own numbers are BYHD and nine digits. The prefix is the forwarder's name, so the rule has
high confidence. No public BYHD number has been found, so the corpus holds a synthetic one.

## Testing

`npm run test:carriers:live -- carriers/byhd`, with `BYHD_TRACKING_NUMBER` and optionally
`BYHD_UNKNOWN_NUMBER` set outside the repository.
