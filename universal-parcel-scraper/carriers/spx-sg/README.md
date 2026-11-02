# SPX Express Singapore

SPX Express Singapore is Shopee's delivery network in Singapore. It delivers Shopee orders
from local sellers, who drop parcels at its points or have them collected, and from overseas
sellers through Shopee's sorting centres abroad and Singapore import. Tracked through the
lookup its tracker makes, with the parser [SPX Express Indonesia](../spx-id/README.md) shares
with the other Southeast Asian networks. `spx-my`, `spx-th` and the other `spx-*` entries
cover Shopee's networks in other countries.

## How it works

1. `direct`: one `GET https://spx.sg/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=en`, as the tracker sends it. It needs no cookie, token,
   signature or browser. The JSON reply has the parcel's scans, newest first.

- An unknown SPXSG number is HTTP 200 with a non-zero `retcode` whose message says the order
  index found none (`find [0]`); that is not found. The lookup gives the same answer for the
  Shopee numbers of parcels it tracks by their SPXSG number, so for a Shopee number it is
  inconclusive. A message saying the order has no scans is no history; other failures are
  inconclusive. A 404 or a redirect is a moved route, and a web page in place of the JSON is a
  gateway's check.
- The reply must name the number asked. A reply to an SPXSG number names only the parcel's
  Shopee number, so it is accepted when that number has Singapore's layout.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant. Parcels from
  abroad are scanned in other zones, so no wall clock is derived.
- Rows flagged hidden, which the page leaves out, are mostly SPX's bookkeeping and are left out
  too. A pickup that collected nothing, import clearance, the arrival at the last-mile hub and
  a return's way back are kept: no row the page shows stands for them, and a return's first
  shown row comes days after the parcel turned back. Repeated rows are left out.
- Scans at SPX's warehouses, forwarders, ports and sorting centres keep the place and
  coordinates the reply gives; facility addresses are not kept. Pickups, deliveries and the
  hand-over to the local partner keep none.
- Tracking codes give the stages, the same ones as at the sister networks.

## Limitations

- Shopee numbers asked by themselves are usually not found, so enabled providers answer them.
- No recognition: the lookup cannot tell an unknown Shopee number from one it only finds
  through its SPXSG number.
- No delivery estimate, weight or delivery partner.

## Numbers

Parcels carry SPXSG followed by eleven digits and a final character, a digit in the archived
lookups and a digit or letter at the sister networks; `spx-sg-1` claims them. The tracker pairs
a parcel with its Shopee SLS number, SG followed by twelve digits and a final digit or letter.
`spx-sg-2` suggests SPX Express Singapore for that layout with low confidence, since the SG
prefix alone does not rule out other senders.

## Links

`spx.sg/track?{number}`, with the number as the whole query string, is the address the
tracker's search builds, under `/m` on phones, and archived lookups use it. Older lookups open
`spx.sg/detail/{number}`.

## Testing

`npm run test:carriers:live -- carriers/spx-sg`, with `SPX_SG_TRACKING_NUMBER` and optionally
`SPX_SG_UNKNOWN_NUMBER`, an SPXSG number, set outside the repository.
