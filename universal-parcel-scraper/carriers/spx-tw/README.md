# SPX Express Taiwan

SPX Express Taiwan runs Shopee's store-to-store service (蝦皮店到店) in Taiwan, where parcels wait
at a pickup store. Its tracker and numbers are separate from the other SPX networks, such as
`spx-ph` and `spx-br`. Tracked through the legacy feed SPX's trackers read.

## How it works

1. `direct`: one `GET https://spx.tw/api/v2/fleet_order/tracking/search` with
   `sls_tracking_number={number}|{seconds}{checksum}`, where `seconds` is the current Unix time
   and `checksum` the SHA-256 hex of the number, those seconds and a fixed salt SPX's public
   tracking clients share, the Philippine tracker's among them. The JSON reply has the parcel's
   scans.

- The feed's gateway refuses a request without a browser's User-Agent with HTTP 403 and an
  action in place of the reply, so the adapter sends a browser's. That refusal, with any
  status, and a web page in place of the JSON are a gateway's check. A 404 or a redirect is a
  moved route.
- A history the feed no longer keeps is `retcode` -1217, no history. An unknown number is a
  server failure, -1000, and a rejected checksum an empty reply; neither proves a missing
  parcel, so both are inconclusive, as are other failures.
- The reply must name the number asked.
- The order lookup the other Southeast Asian networks use answers every Taiwanese number as
  missing, so it is not asked.

## Notes

- Each scan's `timestamp` is Unix seconds, so every scan is an exact instant; no wall clock is
  derived.
- Status names give the stages. A parcel at the buyer's store is ready for pickup; the store in
  brackets after that line is the pickup point and the scan's place. A name in brackets after a
  collection is dropped.
- The reply also carries the recipient's name, phone and payment type, which are not read.
  Repeated scans are kept once.

## Limitations

- Unknown numbers are inconclusive, so enabled providers answer them.
- Scans other than the arrival at the store carry no place.
- No delivery estimate, weight or delivery partner.

## Numbers

Archived lookups on the tracker show TW followed by twelve digits and a final letter, the
layout of other SPX networks' SLS numbers, which can also end in a digit. The low-confidence
rule suggests SPX Express Taiwan for TW, twelve digits and a final digit or letter; the TW
prefix alone does not rule out other senders.

## Links

Archived lookups open `spx.tw/detail/{number}`, which the link rule reads. The current site
sends that path to its not-found page when no number follows, so no parcel address is given.

## Testing

`npm run test:carriers:live -- carriers/spx-tw`, with `SPX_TW_TRACKING_NUMBER` and optionally
`SPX_TW_UNKNOWN_NUMBER` and `SPX_TW_EXPIRED_NUMBER`, a number whose history has expired, set
outside the repository.
