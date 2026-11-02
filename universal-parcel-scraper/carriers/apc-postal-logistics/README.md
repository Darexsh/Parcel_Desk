# APC Postal Logistics

APC Postal Logistics is a US consolidator of international e-commerce parcels. It takes parcels
in at its facilities, flies them abroad and hands them to a delivery partner, often the national
post. Tracked through the lookup its tracker page makes.

## How it works

1. `direct`: one `GET https://tracking.apc-pli.com/api/track?id={number}`, the request the
   tracker page at `tracking.apc-pli.com/{number}` makes while it renders. The page sends it
   without a key, cookie or account, and so does the adapter. The answer is one parcel with its
   scans, newest first.
2. `retry`: one more try when the request fails to reach APC or hangs. The first try gets half
   of the budget.

- The lookup has no not-found answer. A number it does not have, a label it has not received
  yet and a lookup that failed all come back as the same HTTP 500, "Failed to fetch tracking
  data", which the page shows as "Package Not Found". That answer is inconclusive, never
  not-found.
- A 404 is a moved route, a bot check's page is a challenge, and a reply that is not a parcel is
  a changed schema. A parcel without scans has no history yet.
- The parcel must name the number asked as APC's own: `trackingReference2`, or the package
  number while it is not the partner's.
- No recognition: the lookup cannot tell a number it lacks from a failure.

## Notes

- After the handoff, the parcel's package number becomes the delivery partner's number, and the
  tracker opens the parcel by that number too. A reply found by the partner's number is the
  partner's shipment and stays inconclusive here.
- The partner and its number are reported as the delivery carrier and delivery tracking number.
  The partner's name is matched to a catalog carrier together with its tracking link. The
  handoff notice's placeholder is filled with the partner's number, as the page does.
- Every scan carries an ISO clock labelled `+00:00`. APC's own facility scans (label, arrival,
  export and departure) are UTC: archived pages captured shortly after such scans already show
  them, which only UTC allows. Flight and partner scans carry their local wall clock under that label: partner
  deliveries fall in local working hours and flights only take plausible times on local clocks.
  They are kept as `local_time`, and the reply's order stands. A scan with another offset keeps
  it.
- Codes are APC's own and mean the same for every partner. The map reads the code; the wording
  is APC's.
- Places are kept when they hold no digit, which a street or postcode would. The label's place
  can be the sender's, and a delivery, an attempt or a return can happen at the recipient's
  address, so their places are never kept, nor those of unknown codes worded that way.
- The estimate window is kept as calendar days in UTC, as the page shows it, until the parcel
  arrives.
- The destination country is read from the code that ends the recipient's address. The rest of
  the address, the merchant's reference, the partner's free text on scans, the links and the
  service code are not kept.

## Limitations

- No delivery time: partner deliveries have no instant.
- No weight, sender or recipient.

## Numbers

Lookups archived from APC's own tracker show four layouts: five digits, `P`, a six-digit date
and ten digits; five digits, `A` and nine or ten digits; and sixteen digits. A Trustpilot review
and TrackingMore's APC page add sixteen-digit numbers, `PF` and thirteen digits, and ten digits.

`apc-postal-logistics-1` claims the `P` layout and `apc-postal-logistics-2` the `A` layout,
whose ten-digit form also fits Royal Mail's broad hexadecimal shape. Sixteen and ten digits are
shared by many carriers, and the `PF` layout has only aggregator samples, so no rule claims them.
The adapter sends the `P`, `A` and sixteen-digit layouts and refuses anything else without a
request. The samples, the ones the lookup answers and their sources are in
[`numbers.json`](numbers.json).

## Links

APC's tracker opens one parcel at `tracking.apc-pli.com/` followed by the number. Its handoff
notice links the partner's number to the same address, which the library reads as APC's.

## Testing

`npm run test:carriers:live -- carriers/apc-postal-logistics`, with
`APC_POSTAL_LOGISTICS_TRACKING_NUMBER` and optionally `APC_POSTAL_LOGISTICS_UNKNOWN_NUMBER` set
outside the repository.
