# SPX Express Thailand

SPX Express Thailand is Shopee's delivery network in Thailand. It collects from sellers in
Thailand, carries Shopee's parcels from overseas sellers through its warehouses abroad and
Thai customs, and delivers to the door. Tracked through the lookup its tracker makes, with the
parser [SPX Express Indonesia](../spx-id/README.md) shares with the other Southeast Asian
networks. `spx-ph` and `spx-br` cover the Philippine and Brazilian networks.

## How it works

1. `direct`: one `GET https://spx.co.th/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=th`, as the tracker sends it. It needs no cookie, token,
   signature or browser. The JSON reply has the parcel's scans, newest first.

- An unknown SPXTH number is HTTP 200 with a non-zero `retcode` whose message says the order
  index found none (`find [0]`); that is not found. The lookup finds domestic parcels by their
  Shopee numbers too, but parcels from abroad only by their SPXTH number, so for a Shopee
  number that answer is inconclusive. A message saying the order has no scans is no history;
  other failures are inconclusive. A 404 or a redirect is a moved route, and a web page in
  place of the JSON is a gateway's check.
- The reply must name the number asked. A reply to an SPXTH number for a parcel from abroad
  names only its Shopee number, so it is accepted when that number has Thailand's layout; an
  order SPX ships on its own names both of its numbers.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant. Parcels from
  abroad are scanned in other zones, so no wall clock is derived.
- `th` is the page's own language. Its lines name no one. Scans without a line keep their
  English tracking name.
- Rows flagged hidden, which the page leaves out, are mostly SPX's bookkeeping and are left out
  too. A pickup that collected nothing, import clearance, the arrival at the last-mile hub and
  a return's way back are kept: no row the page shows stands for them, and a return's first
  shown row comes days after the parcel turned back.
- Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres keep the place and
  coordinates the reply gives. The line-haul end names the place the truck left, so it keeps
  none, nor do drop-offs, pickups, deliveries and the final return, which can name the
  seller's or the recipient's area. Facility addresses, standalone orders' drivers, references
  and delivery estimates are not kept.
- Tracking codes give the stages. The arrival at Thai customs, worded as an inspection, is
  customs. Assigning a driver is still in transit, every leg of a return is returned, and a
  stalled return is an exception.

## Limitations

- Shopee numbers of parcels from abroad are not found by themselves, so enabled providers
  answer them.
- No recognition: the lookup cannot tell an unknown Shopee number from one it only finds
  through its SPXTH number.
- No delivery estimate, weight or delivery partner.

## Numbers

Marketplace parcels carry SPXTH followed by eleven digits and a final digit or letter. The
tracker pairs each with an SLS number, TH followed by twelve digits and usually a final digit
or letter. The SPXTH prefix names this network, so its rule has high confidence. The
low-confidence rule suggests SPX Express Thailand for the SLS layout, whose TH prefix alone
does not rule out other senders. Flash Express numbers also start with TH but mix letters into
the middle, so the two rules do not overlap.

## Links

`spx.co.th/track?{number}`, with the number as the whole query string, is the address the
tracker's search builds, under `/m` on phones, and archived lookups use.

## Testing

`npm run test:carriers:live -- carriers/spx-th`, with `SPX_TH_TRACKING_NUMBER` and optionally
`SPX_TH_UNKNOWN_NUMBER`, an SPXTH number, set outside the repository.
