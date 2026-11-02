# SunYou

SunYou (SYPost) carries small parcels from China to Europe and usually hands them to a local post
for the last mile. This folder covers the journey up to that handoff.

## How it works

1. `direct`: one keyless GET to `https://sypost.net/queryTrack?queryTime=…&toLanguage=en_US&trackNumber={number}`,
   the endpoint behind the public search page. `queryTime` is a cache-buster. The reply is JSONP
   (`callbackName({…})`) and is unwrapped before parsing. No retry: there is no session to rebuild.

## Notes

- A body that doesn't unwrap (an HTML outage or bot challenge) is a `SchemaError`, never not-found:
  a not-found would stop syncing a parcel that still exists.
- Not-found is `displayStatus: "0"` or `has !== true`. Only the record whose `orderNo` matches the
  requested number is read.
- Each shipment has two legs, `result.origin` and `result.destination`, each stamping its own
  `timeZone` (`+08:00`, then a European offset). Each scan gets its leg's offset and events are
  sorted by instant; sorting the wall-clock strings made Chinese scans look newer than later
  European ones.
- A scan without a usable offset keeps the provider's raw text. No zone is guessed (not even
  Asia/Shanghai). `core/time`'s `explicitOffsetTime` is not used because it drops values it can't
  resolve.
- Each scan's `eventCode` is kept as its provider code and gives its stage (`status.ts`).
  `displayStatus` is shipment-level, so only the newest scan falls back to it, and only when its
  code is unknown. The newest scan's code also refines the generic in-transit `displayStatus`, for
  example to customs.
- Scans with an unknown code are classified by the sync's shared wording rules.
- `trackingNumber`, when it differs from the requested number, is the last-mile reference. The
  carrier named beside it (`carrierName`, `carrierWebsite`) is reported only when the catalog knows
  it, its detection offers the reference and it serves the destination (`dstCountry`). For postal
  items SunYou names the post it exports through, such as China Post for a parcel to Japan, so no
  carrier is named for a postal number issued in another country than the destination; the
  hand-off then goes by the destination's national post where the catalog has one, else by the
  number's issuer.
- The departure's wording ends with that reference ("Carrier Tracking Number: …"). It is left
  out of the scan, since the hand-off carries it, and out of a universal provider's copy too.
- `delivered_at` is the time of the newest scan when that scan is a delivery.
- Numbers are `SY` and eleven digits, or `SY`, two letters and nine digits (`SYUS`, `SYGB`, `SYRM`,
  `SYAE` and others). `SYMY` numbers seen in archives answer not found.

## Limitations

- Scan locations are not read, and the endpoint has no ETA. At most 20 scans are kept.
- Recent replies put every scan in the origin leg, the last-mile ones included.
- The recipient block and signature image are never read.

## Testing

`npm run test:carriers:live -- carriers/sunyou` needs no env vars; it checks that a
synthetic number returns not-found.
