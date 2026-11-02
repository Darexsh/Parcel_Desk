# Safe Way Express Cargo

Tracks shipments of Safe Way Express Cargo, a Bahrain carrier running land freight, last-mile
delivery and e-commerce logistics across the Gulf states, with branches in Saudi Arabia, the
United Arab Emirates and Oman. Some shipments are handed to Aramex. Its site is safewayxp.com.

## How it works

1. `direct`: one GET to the tracking page `www.safewayxp.com/track.php?awb=<number>`, which the
   server renders with the shipment or with "Tracking Information Not Found", both with HTTP 200.
2. `retry`: the same read once more after a request fails to reach the page or hangs. The first
   gets half of the budget.

No account, key, cookie, CAPTCHA or browser is needed. Recognition makes the same request.

## Notes

- The page prints the number over the shipment, which must be the number asked. Its not-found
  answer does not, but the search field above it repeats the number the page looked up.
- The page takes several numbers separated by spaces or commas. The adapter asks for one, of
  letters and digits only.
- The shipment's information names the carrier, that carrier's tracking number and the day it
  shipped. The shipped day becomes a `Shipped` scan, a day without a clock or zone. When the
  carrier is Aramex, Aramex is the delivery carrier and its number the delivery number, so a
  lookup also asks Aramex.
- The status over the shipment is staged by the shared wording rules. Without one, the
  shipment's stage is its shipped scan.
- The shipping details are not kept.

## Limitations

Safe Way's answer is a summary, marked `summary_only`. No live answer listed scans in its
timeline, so a page that lists some is read as a malformed reply until their layout is known.
Other carriers the page names are not delivery partners yet.

## Numbers

The tracking page's example is BH and eight digits, and its tracker answers it. It is one sample,
so the rule is low and shared with TNT Italy's; recognition asks the tracker. Other branches may
use other prefixes, so the adapter asks about any number of letters and digits.

## Links

The tracking page opens the number from its `awb` parameter.

## Testing

`npm run test:carriers:live -- carriers/safeway-express-cargo`, with
`SAFEWAY_EXPRESS_CARGO_TRACKING_NUMBER` and optionally `SAFEWAY_EXPRESS_CARGO_UNKNOWN_NUMBER` set
outside the repository.
