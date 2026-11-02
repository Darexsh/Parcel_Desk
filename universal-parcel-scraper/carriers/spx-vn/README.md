# SPX Express Vietnam

SPX Express Vietnam is Shopee's delivery network in Vietnam. It collects from sellers, sorts
through its own hubs and delivers to the door. Tracked through the lookup its tracker makes,
with the parser [SPX Express Indonesia](../spx-id/README.md) shares with the other Southeast
Asian networks. `spx-ph` and `spx-br` cover the Philippine and Brazilian networks.

## How it works

1. `direct`: one `GET https://spx.vn/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=vi`, as the tracker sends it. It needs no cookie, token,
   signature or browser. The JSON reply has the parcel's scans, newest first.

- An unknown SPXVN number is HTTP 200 with a non-zero `retcode` whose message says the order
  index found none (`find [0]`); that is not found. The lookup gives the same answer for the
  Shopee numbers of parcels it tracks by their SPXVN number, so for a Shopee number it is
  inconclusive. A message saying the order has no scans is no history; other failures are
  inconclusive. A 404 or a redirect is a moved route, and a web page in place of the JSON is a
  gateway's check.
- The reply must name the number asked. A reply to an SPXVN number names only the parcel's
  Shopee number, so it is accepted when that number has Vietnam's layout; an order SPX ships
  on its own names both of its numbers.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant; no wall clock
  is derived.
- `vi` is the page's own language. Its lines name no one. Scans without a line keep their
  English tracking name.
- Rows flagged hidden, which the page leaves out, are mostly SPX's bookkeeping and are left out
  too, as are failed delivery attempts the page does not show. A pickup that collected nothing,
  import clearance, the arrival at the last-mile hub and a return's way back are kept: no row
  the page shows stands for them, and a return's first shown row comes days after the parcel
  turned back.
- Scans at SPX's hubs and sorting centres keep the place and coordinates the reply gives. The
  line-haul end names the place the truck left, so it keeps none, nor do drop-offs, pickups,
  deliveries and the final return, which can name the seller's or the recipient's area.
  Facility addresses are not kept.
- Tracking codes give the stages. A failed pickup leaves the parcel registered, assigning a
  driver is still in transit, every leg of a return is returned, and a stalled return is an
  exception.

## Limitations

- Shopee numbers asked by themselves are usually not found, so enabled providers answer them.
- No recognition: the lookup cannot tell an unknown Shopee number from one it only finds
  through its SPXVN number.
- No delivery estimate, weight or delivery partner.

## Numbers

Marketplace parcels carry SPXVN followed by eleven digits and a final digit or letter. The
tracker pairs each with an SLS number, VN followed by twelve digits and a final digit or
letter. The SPXVN prefix names this network, so its rule has high confidence. The
low-confidence rule suggests SPX Express Vietnam for the SLS layout, whose VN prefix alone does
not rule out other senders.

## Links

`spx.vn/track?{number}`, with the number as the whole query string, is the address the
tracker's search builds, under `/m` on phones, and archived lookups use.

## Testing

`npm run test:carriers:live -- carriers/spx-vn`, with `SPX_VN_TRACKING_NUMBER` and optionally
`SPX_VN_UNKNOWN_NUMBER`, an SPXVN number, set outside the repository.
