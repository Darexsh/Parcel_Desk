# Logistiq

Logistiq is a UAE and Saudi courier and logistics company. Recipients get an airwaybill that
opens Logistiq's tracker, and Logistiq's drivers deliver. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://robin.logistiq.io/v1/order-details?alpha_awb={number}`, as the
   tracker at `gecko.logistiq.io/#/order/tracking?awb={number}` makes it once it has loaded. It
   needs no cookie, token, key or browser. The JSON reply has the shipment's summary, its order
   details, its current status and its scans, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown airwaybill is HTTP 400 with `status` false and `{number} is an invalid AWB. Kindly
  provide valid CP AWB`, which the page reports as not found. Another 400 reply is a changed
  one, and a 404 or a redirect is a moved route.
- The lookup does not know an airwaybill in lower case, so the adapter sends capitals.
- The shipment's `waybill` must be the number asked, and so must the number a not-found answer
  names.
- Cloudflare stands in front of the service. Its browser check in place of the reply is a
  challenge.
- Recognition makes the same request.

## Notes

- `scan_time` is UTC to the microsecond, with a `Z`. The page shows it in the visitor's own
  zone, and Logistiq's webhook documentation gives the same fields with `+00:00`, so each scan
  is an instant, cut to the second. Without `scan_time`, the record's `time_stamp` stands in.
- The page lists the scans newest first. The current status repeats the newest scan and is kept
  once.
- A scan's wording is its `remarks`, then each part of `additional_remarks` that says something
  more, joined by ` | ` as the page shows them, such as `Order Delivery Failed | Future Date
  Delivery | Not available`. A part with a phone number, an e-mail address, a code or a link is
  left out, and a clause naming who took the parcel is cut. A scan without remarks gets its
  status name.
- `status_code` stages a scan. The tracker numbers a pickup by Logistiq's drivers 109, which the
  webhook documentation does not list; there, `PICKED_UP` is 105. A customer's return, from the
  customer to the merchant, has codes of its own.
- A pickup scan's `scan_location` is the sender's address, and a return pickup's the
  customer's, so only a hub's code becomes the location.
- The destination's country is kept, its town is not. The order details the page shows, such as
  the merchant's references, the invoice, the cash-on-delivery amount and the contents, are not
  kept.
- `cp_name` names the courier that carries the parcel, `Logistiqcp` for Logistiq's own fleet.
  The reply names no airwaybill but the one asked, so there is no hand-off.

## Limitations

- No weight, service or proof of delivery. The reply's `expected_delivery_date` is not read,
  since its format is unknown.
- The layout comes from two airwaybills, so the adapter takes seven to nine letters and nine
  digits, and no rule claims them. A number reaches the adapter when it is filed under
  Logistiq.

## Numbers

Its airwaybills are seven to nine letters followed by nine digits, and the letters vary from
shipment to shipment. A buyer's question on a marketplace, quoting the tracker link, and the
sample in Logistiq's webhook documentation give them. Two numbers do not show which letters are
fixed, so no rule claims the layout and the gap is declared. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

The tracking page on `logistiq.io/track/` sends the number to
`gecko.logistiq.io/#/order/tracking?awb={number}`, which opens one parcel. The number sits in
the fragment, which the link rule reads.

## Testing

`npm run test:carriers:live -- carriers/logistiq`, with `LOGISTIQ_TRACKING_NUMBER` and
optionally `LOGISTIQ_UNKNOWN_NUMBER` set outside the repository.
