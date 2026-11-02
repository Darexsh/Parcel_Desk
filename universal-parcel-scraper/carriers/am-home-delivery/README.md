# AM Home Delivery

AM Home Delivery is a New York based two-person home delivery carrier for furniture, mattresses
and appliances. Its tracking page looks up one number and shows the current status, the
delivery estimate and the scan history. Tracked through the page its tracking form opens.

## How it works

1. `direct`: one `GET https://www.amtrucking.com/track-number.php?cnumber={number}`, as the
   tracking form sends it. It answers with a redirect to a NetSuite page of the carrier's
   account, `4301600.extforms.netsuite.com/app/site/hosting/scriptlet.nl`, whose address
   carries the number and an access parameter, and a second `GET` opens that page. Neither
   needs a cookie, key or browser. The page renders the shipment as HTML.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The redirect must lead to that page with the number asked. The adapter takes the access
  parameter from each redirect rather than keeping one, since the carrier has changed it before.
- A number the page holds no shipment under gets the notice "Please Enter a Valid BOL Number.",
  which names no number. A 404, a 410 or a redirect of the page is a moved route, and
  NetSuite's error page, an HTTP 500, is inconclusive.
- The page finds a shipment by its track number or by the shipper's bill of lading number. The
  adapter asks by whole track number only and keeps a shipment only when the page heads it with
  that number; one found by its bill of lading number is inconclusive and nothing from it is
  kept.
- Recognition makes the same requests.

## Notes

- A row's day and twelve-hour time name no zone, and rows come from terminals across the
  country, so clocks stay wall clocks in `local_time` and no event has an instant.
- The last mile status, the shipment's status and the progress rail's current step can be ahead
  of the rows: an order is `Scheduled` before its row, and the rail reaches `Out For Delivery`
  without one. A delivery, from a row or the summary, settles the shipment; a problem in the
  newest staged row, then in the summary, comes next; otherwise the further of that row and the
  summary decides. A summary ahead of every row has no clock. The shipment's status stays
  `Received in Delivery Terminal` after the delivery, so the last mile status's wording comes
  first.
- Until the delivery, the estimate is the appointment's day, or the range of days the page
  shows before one. The appointment's hours name no zone and are not kept.
- A row's place keeps its town and state without the ZIP code; a place reading `In Transit`
  names none. The delivery address's town and ZIP code, the bill of lading number, the products
  and the day the order came in are not kept. The page's issue form is never used.

## Limitations

- No sender, recipient, signature, proof of delivery or weight: the page shows none.
- A number reaches the adapter when it is filed under AM Home Delivery or opened from its link:
  no rule claims its numbers, so preflight does not ask it.
- The current page does not hold the older tracker's seven-digit PRO numbers and reads such a
  number as a bill of lading number, so the adapter does not look them up. Bill of lading
  numbers are the shippers' own, some only five digits long, and the adapter never sends one.

## Numbers

Archived lookups show seven-digit PRO numbers on the older Carrier Logistics tracker, and on
the current page eight-digit track numbers and, on newer orders, `AM` and nine digits; the
current page also lists the shipper's bill of lading number. Bare digit runs of these lengths
are other carriers' numbers too, and one `AM` sample is too few for a rule, so no rule claims
them and gap declarations cover the three layouts. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`amtrucking.com/track-number.php?cnumber={number}` opens one shipment: the carrier's tracking
form builds it and archived lookups use it. Older lookups on
`tracking.carrierlogistics.com/scripts/amh.pol/boldetail.htm` carry the PRO number in `wpro1`.

## Testing

`npm run test:carriers:live -- carriers/am-home-delivery`, with
`AM_HOME_DELIVERY_TRACKING_NUMBER` and optionally `AM_HOME_DELIVERY_UNKNOWN_NUMBER` set outside
the repository.
