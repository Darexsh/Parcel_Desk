# SPX Express Indonesia

SPX Express Indonesia is Shopee's delivery network in Indonesia. It collects from sellers,
sorts through its own hubs and delivers to the door. Tracked through the lookup its tracker
makes. `spx-my`, `spx-sg`, `spx-th`, `spx-vn`, `spx-ph` and `spx-br` cover SPX's other networks,
whose numbers carry their own country codes; `spx-id/regional.ts` holds the lookup and parser
the five Southeast Asian order lookups share.

## How it works

1. `direct`: one `GET https://spx.co.id/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=id`, as the tracker sends it for the number in its address.
   It needs no cookie, token, signature or browser. The JSON reply has the parcel's scans,
   newest first.

- An unknown SPXID number is HTTP 200 with a non-zero `retcode` whose message says the order
  index found none (`find [0]`); that is not found. The lookup gives the same answer for the
  Shopee numbers of parcels it tracks by their SPXID number, so for a Shopee number it is
  inconclusive. A message saying the order has no scans is no history; other failures are
  inconclusive. A 404 or a redirect is a moved route, and a web page in place of the JSON is a
  gateway's check.
- The reply must name the number asked. A reply to an SPXID number names only the parcel's
  Shopee number, so it is accepted when that number has Indonesia's layout; an order SPX ships
  on its own names both of its numbers.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant. Indonesia
  spans three zones, so no wall clock is derived.
- `id` is the page's own language. Its delivery line ends with who took the parcel, which is
  dropped. Scans without a line keep their English tracking name.
- Rows flagged hidden, which the page leaves out, are mostly SPX's bookkeeping and are left out
  too. A pickup that collected nothing, import clearance, the arrival at the last-mile hub and
  a return's way back are kept: no row the page shows stands for them, and a return's first
  shown row comes days after the parcel turned back.
- Scans at SPX's hubs and sorting centres keep the place and coordinates the reply gives. The
  line-haul end names the place the truck left, so it keeps none, nor do pickups, deliveries
  and the final return, which can name the seller's or the recipient's area. Facility
  addresses are not kept.
- Tracking codes give the stages. Assigning a driver is still in transit, every leg of a
  return is returned, and a stalled return is an exception.

## Limitations

- Shopee numbers asked by themselves are usually not found, so enabled providers answer them.
- No recognition: the lookup cannot tell an unknown Shopee number from one it only finds
  through its SPXID number.
- No delivery estimate, weight or delivery partner.

## Numbers

Marketplace parcels carry SPXID followed by eleven digits and a final digit or letter. The
tracker pairs each with an SLS number, ID followed by twelve digits and, on newer parcels, a
final digit or letter. The SPXID prefix names this network, so its rule has high confidence.
The low-confidence rule suggests SPX Express Indonesia for the SLS layout, whose ID prefix
alone does not rule out other senders.

## Links

`spx.co.id/track?{number}`, with the number as the whole query string, is the address the
tracker's search builds, under `/m` on phones, and archived lookups use. Older lookups open
`spx.co.id/detail/{number}`.

## Testing

`npm run test:carriers:live -- carriers/spx-id`, with `SPX_ID_TRACKING_NUMBER` and optionally
`SPX_ID_UNKNOWN_NUMBER`, an SPXID number, set outside the repository.
