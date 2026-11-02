# SPX Express Malaysia

SPX Express Malaysia is Shopee's delivery network in Malaysia. It collects from sellers in
Malaysia, carries Shopee's parcels from overseas sellers through its warehouses abroad and
Malaysian import, and delivers to the door or a collection point. Tracked through the lookup
its tracker makes, with the parser [SPX Express Indonesia](../spx-id/README.md) shares with
the other Southeast Asian networks. `spx-ph` and `spx-br` cover the Philippine and Brazilian
networks.

## How it works

1. `direct`: one `GET https://spx.com.my/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=en`, as the tracker sends it. It needs no cookie, token,
   signature or browser. The JSON reply has the parcel's scans, newest first.

- An unknown SPXMY number is HTTP 200 with a non-zero `retcode` whose message says the order
  index found none (`find [0]`); that is not found. The lookup gives the same answer for the
  Shopee numbers of parcels it tracks by their SPXMY number, so for a Shopee number it is
  inconclusive. A message saying the order has no scans is no history; other failures are
  inconclusive. A 404 or a redirect is a moved route, and a web page in place of the JSON is a
  gateway's check.
- The reply must name the number asked. A reply to an SPXMY number names only the parcel's
  Shopee number, so it is accepted when that number has Malaysia's layout; an order SPX ships
  on its own names both of its numbers.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant. Parcels from
  abroad are scanned in other zones, so no wall clock is derived.
- The adapter asks for `en`: its lines name no one, while the `ms` and `zh` lines put the
  recipient's name after a delivery.
- Rows flagged hidden, which the page leaves out, are mostly SPX's bookkeeping and are left out
  too. A pickup that collected nothing, import clearance, the arrival at the last-mile hub and
  a return's way back are kept: no row the page shows stands for them, and a return's first
  shown row comes days after the parcel turned back.
- Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres keep the place and
  coordinates the reply gives. The line-haul end names the place the truck left, so it keeps
  none, nor do drop-offs, pickups, deliveries and the final return, which can name the
  seller's or the recipient's area. Facility addresses are not kept.
- Tracking codes give the stages. A delay notice worded "Exception" stages nothing, as the
  parcel moves on. Arriving at the destination port is still in transit, a trip to a
  collection point is out for delivery, every leg of a return is returned, and a stalled
  return is an exception.

## Limitations

- Shopee numbers asked by themselves are usually not found, so enabled providers answer them.
- No recognition: the lookup cannot tell an unknown Shopee number from one it only finds
  through its SPXMY number.
- No delivery estimate, weight or delivery partner.

## Numbers

Marketplace parcels carry SPXMY followed by eleven digits and a final digit or letter. The
tracker pairs each with an SLS number, MY followed by twelve digits and a final digit or
letter. The SPXMY prefix names this network, so its rule has high confidence. The
low-confidence rule suggests SPX Express Malaysia for the SLS layout, whose MY prefix alone
does not rule out other senders.

## Links

`spx.com.my/track?{number}`, with the number as the whole query string, is the address the
tracker's search builds, under `/m` on phones, and archived lookups use. Older lookups open
`spx.com.my/detail/{number}`. The site's search markup names
`spx.com.my/en/tracking?tracking_no={number}` as its search address.

## Testing

`npm run test:carriers:live -- carriers/spx-my`, with `SPX_MY_TRACKING_NUMBER` and optionally
`SPX_MY_UNKNOWN_NUMBER`, an SPXMY number, set outside the repository.
