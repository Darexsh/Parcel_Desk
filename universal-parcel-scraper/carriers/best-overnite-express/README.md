# Best Overnite Express

Best Overnite Express is a family-run regional LTL carrier based in Southern California. It
serves California, Arizona, Nevada and Utah with its own trucks, the rest of North America
through partners, and also runs residential and unattended deliveries. Tracked through the
lookup its tracking page's widget makes.

## How it works

1. `direct`: one `POST https://trackingprod.bestovernite.com/api/Tracking/GetTrackingDetails`
   with the body `{"trackingType":"PRO","trackingNumber":"{pro}"}`, as the widget on
   `bestovernite.com/shipment-tracking/` sends it. It needs no cookie, token, key or browser,
   although the widget sends a reCAPTCHA token and a key from its settings. The JSON reply holds
   one shipment, its parties and its scans, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A PRO number without a shipment is HTTP 200 with the error `BADPRONBR` and the number asked.
  The same error without a number refuses the number's form. A validation answer (HTTP 400)
  is a changed request, and a 404 or a redirect is a moved route.
- The service pads a shorter number with zeros and answers for whichever PRO number that makes.
  The adapter sends only eight or nine digits, padded to the nine the service gives a PRO number,
  and keeps a reply only when its `proNum` is the number asked.
- Recognition makes the same request.

## Notes

- A scan has a day and a clock to the minute, with no zone, and its place is a terminal's town
  without a state. The clocks are read in Pacific time when the shipper and the consignee are
  both in California or Washington, where the carrier's zone and every place's agree. Elsewhere,
  as in Arizona or Nevada, they stay wall clocks in `local_time`.
- Midnight is a day without a time, as on pickups.
- A delivery's place is who signed, so it is not kept. Any other place is kept only as a town in
  letters and spaces that names nobody the reply names.
- A delivery settles the shipment whatever is recorded after it.
- The page shows the status line only for a shipment without scans. A delivery's line gives the
  day and time and who signed; the adapter keeps the delivery as a summary without the signer.
- The reply gives an estimated delivery day, which the page does not show. It is kept until the
  delivery.
- The reply also names the shipper and the consignee with their addresses and ZIP codes, who
  signed, the bill of lading, purchase order and pickup numbers, the pallet count and the ship and
  delivery days. Only the parties' states are read, to settle the clocks' zone; none of them is
  kept.

## Limitations

- No sender, recipient, signature, weight or service.
- PRO numbers run densely without a check digit, so a mistyped number can open another
  shipment, and the adapter cannot tell.
- The widget also finds shipments by bill of lading, purchase order or pickup number, and the
  classic trace took an interline PRO with the partner's SCAC. The adapter tracks only the
  carrier's own PRO number.
- A PRO number reaches the adapter when it is filed under Best Overnite or opened from a Best
  Overnite link: eight digits are shared by many carriers, so no rule claims them and preflight
  does not ask it.

## Numbers

Shipments are traced by the carrier's PRO number, eight digits on the archived classic trace,
which the service gives as nine with a leading zero. [`numbers.json`](numbers.json) holds an
invented placeholder: the tracker names the consignee and the signer of the archived public
sample.

## Links

The classic trace takes the PRO number in `wbfb` on `cgi-bin/wbprotrk`, on
`tgif.bestovernite.com` and formerly on `www.bestovernite.com`; the library reads the number
from that address. The current tracking page uses a script widget with no number in its
address.

## Testing

`npm run test:carriers:live -- carriers/best-overnite-express`, with
`BEST_OVERNITE_EXPRESS_TRACKING_NUMBER` and optionally `BEST_OVERNITE_EXPRESS_UNKNOWN_NUMBER` set
outside the repository.
