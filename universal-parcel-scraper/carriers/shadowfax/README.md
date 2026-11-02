# Shadowfax

Shadowfax is an Indian last-mile and e-commerce courier that delivers and picks up returns for
marketplaces and online shops. Tracked through the delivery service its tracker reads.

## How it works

1. `direct`: one `GET https://saruman.shadowfax.in/web_app/delivery/track/{number}/` with
   `Authorization: Token …`, the token the tracker's script and the website's track page send
   for every visitor. It needs no cookie, captcha or browser. The JSON reply has the order's
   summary and the scans of its current milestone.
2. `retry`: one more try after a request that fails to reach Shadowfax or hangs. The first try
   gets half of the budget.

- For a number it has no delivery request under, the service answers HTTP 400 with a message.
  The adapter then asks the lookup the tracker opens a parcel with,
  `GET /awb/awb_to_unique_code/?order_id={number}`. Its HTTP 400 `Invalid AWB Number` answer,
  which the page shows, is the only one read as a missing parcel. A number that lookup knows,
  such as a Shadowfax Connect order, is inconclusive.
- A wrong token is HTTP 401, reported as a challenge. A 404 or a redirect is a moved service.
- The reply must name the number asked.
- Recognition makes the same requests. A record without scans is a parcel Shadowfax knows.

## Notes

- Scan clocks are India's wall clock to the second, with no offset. The tracker's page formats
  them in `Asia/Kolkata`, which has no daylight saving, so the adapter reads them there as
  instants.
- The public reply holds the scans of the parcel's current milestone only, so a delivered
  parcel shows its delivery scan. The tracker shows more after a one-time code sent to the
  recipient's phone, which the adapter does not ask for. A history that does not start at
  `Order Received` is marked truncated.
- A scan's description is its milestone's heading, then its own line, as the page lists them:
  `In Transit: Shipment is received at …`. The milestone's number (`main_status_id`) stages it,
  else its heading. The summary's `status_id` stages a parcel whose newest scan has no stage.
- `Delivery failed`, milestone 8, means Shadowfax sends the parcel back to the seller, so it is
  an exception rather than a failed attempt.
- The location is the facility a scan's line names.
- The reply's masked phone number, delivery remark and proof of delivery are not kept. Lines
  lose phone numbers and one-time codes.

## Limitations

- No history before the current milestone.
- Shadowfax Connect orders, which the tracker reads from another service, are not tracked.
- No weight, service, sender, recipient or delivery partner.

## Numbers

The tracker asks for an AWB number. Customers quote `SF`, nine to twelve digits and a
three-letter merchant code, which `shadowfax-1` claims, and for return pickups `R`, ten digits
and the merchant code, which `shadowfax-2` suggests with low confidence because few reports
show it. The tracker also knows AWBs whose merchant code has one or two letters, which no rule
claims yet. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The search page sends the number to Shadowfax's tracker, which opens one parcel at
`tracker.shadowfax.in/#/awb/{number}`. The tracker turns the AWB into an internal code and
redirects to `#/track/{code}/{type}`; that code is not the AWB, so only the `awb` route is
read.

## Testing

`npm run test:carriers:live -- carriers/shadowfax`, with `SHADOWFAX_TRACKING_NUMBER` and
optionally `SHADOWFAX_UNKNOWN_NUMBER` set outside the repository.
