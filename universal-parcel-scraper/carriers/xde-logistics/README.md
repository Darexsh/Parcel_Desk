# XDE Logistics

XDE Logistics (Ximex Delivery Express) is a Philippine courier and freight forwarder. Its
XpresParcel service delivers online sellers' parcels across the country. Tracked through the
lookup its tracker on the home page of `www.xde.com.ph` makes.

## How it works

1. `direct`: one `GET https://xdelogistics.com/api/v2/client/public/services/shipment/{number}/history`,
   the request the home page's tracking form, or a `tn` in its address, makes. It needs no
   cookie, token, key, phone digits or browser. The JSON reply has the shipment's number, its
   current status and its scans, newest first.
2. `retry`: the same read once more when XDE cannot be reached. The first gets half of the
   budget.

- A number the lookup does not hold gets HTTP 404 with `{"code":404,"message":"Invalid"}`, which
  the page reports as not found. Another JSON 404 is a changed reply; the site's HTML page for a
  missing route, a 410 or a redirect is a moved route.
- The lookup answers a number in any case and names it in capitals. The shipment must name the
  number asked. The adapter sends six to forty letters and digits with at least one digit.

## Notes

- A scan's `created_at` is a wall clock to the second with no zone. XDE delivers only in the
  Philippines, which keep one offset all year, so the clocks are read in Manila time. An
  archived reply holds a scan whose clock, read as UTC, would come after the capture.
- Scans carry a status name and no code; the names are mapped. Each status comes with a fixed
  sentence explaining it, which is not kept. The page leaves out a scan without a status, and
  so does the adapter.
- The current status settles a delivery or a return whose scan is missing; otherwise the
  newest staged scan does. A shipment without scans is a summary of its current status.
- A scan's `reference` names the facility on a hub receipt, which becomes its location. On a
  delivery it names who took the parcel, so no other scan's reference is kept.
- The consignee's name, the recipient's city and province, the staff and remark fields and the
  shipment's internal id are not kept.
- The former tracker at `xdelogistics.com/tracking.html` read an older `/api/status/{number}`
  route with snake_case status codes. The current page does not use it, and neither does the
  adapter.
- Recognition is not declared: the lookup tells a known number from an unknown one, but no
  detection rule offers XDE for a number, so recognition would never ask it.

## Limitations

- No ETA, weight, service, sender or proof of delivery.

## Numbers

XDE tracker lookups show numbers made of X and ten digits, and its tracking API answered for a
number made of XSO and twelve digits. Both shapes come from too few samples to claim, so there
is no detection rule and a number is only matched to XDE when the user or a provider names the
carrier. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The library reads a number from the `tn` query parameter on the home page of `www.xde.com.ph`
and `xde.com.ph`, and from the `trackingnumber` query parameter of `/tracking.html` on
`xdelogistics.com` and `www.xdelogistics.com`, the address of the former tracker.

## Testing

`npm run test:carriers:live -- carriers/xde-logistics`, with `XDE_LOGISTICS_TRACKING_NUMBER` and
optionally `XDE_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
