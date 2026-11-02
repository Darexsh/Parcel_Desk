# CEVA Logistics

CEVA Logistics is the freight and contract logistics arm of the CMA CGM group. Its home
delivery service brings furniture and appliances bought online to the door, in a delivery window
it books with the customer. Tracked through the public lookup behind myCEVA's tracking page,
which opens the same shipments as CEVA Trak.

## How it works

1. `direct`: `GET https://my.cevalogistics.com/api/wso2/fm/shipment/trackntrace/public/1.0.0/shipments/{number}/HB`,
   the lookup the tracking page makes to open a house bill. The JSON reply has the shipment's
   summary and its events grouped by terminal. When the lookup does not know the number as a
   house bill, the page's own search, `GET .../shipments?query={number}&max_results=10`, finds
   the shipment it belongs to, and the lookup opens that shipment's house bill. None of it needs
   a cookie, token, key or browser.
2. `retry`: one more attempt after a failed connection or a timeout. An HTTP status is never
   sent again.

- An unknown house bill is HTTP 404 with `{"status":404,"message":"No results"}`. A number
  that neither the lookup nor the search knows is not found. Another 404 or a redirect is a
  moved route, and a 403 a refusal.
- The search matches the start of every reference a shipment has and says which one matched.
  A result counts when that reference is the whole number and is a house bill or an order
  number (`OrderNumber`, `OrderID`, `PurchaseOrderReference`). Bookings, bills of lading and
  containers also find shipments, but a parcel tracker is not handed them. Several matching
  shipments, more matches than the search lists, or a shipment of a module the lookup does not
  open are inconclusive.
- The shipment must name the house bill asked, or the one the search matched. A match through
  an order number reports the house bill as the canonical number.
- Recognition makes the same requests.

## Notes

- CEVA Trak on `www.cevalogistics.com` sits behind a Cloudflare check that turns away clients
  other than browsers. myCEVA's lookup answers them.
- An event's `local_date` is its terminal's wall clock, written with a `+0000` offset whatever
  the terminal's zone, so the clocks stay `local_time`. The confirmation of a delivery window
  (`APPSET`) is the exception: its clock is UTC, the instant of its entry in the shipment's
  exception log, so it is kept as `time`. The history lists it by that clock among the wall
  clocks, as the page does, which in the Americas places it hours late, so the newest event of
  the shipment's stage heads the result rather than the newest event.
- The event's `milestone_code` stages it. Delivery window offers, confirmations and changes, and
  a failed call to the customer, move nothing. The check-out for delivery (`CHKOFD`) hands the
  freight to the final-mile crew, days before the delivery run in some histories and after the
  delivery in others, so it stays in transit.
- The shipment's milestone settles a delivery or a closure, and a cancelled booking is an
  exception. The expected delivery is the estimated arrival day the page shows, else the
  scheduled day.
- A hub named by code alone has no location. The destination terminal's events name the
  customer's town.
- Signers and staff ids, the remarks with each window's times, references, packages, freight
  terms, the exception log and the postcode fields are not kept.

## Limitations

- No offset timestamps for the terminals' events and no delivery time as an instant.
- myCEVA tracks ground, brokerage and contract logistics orders through other services, which
  the adapter does not read.
- A booking without events has no history.
- The search covers recent shipments. An older one is found by its house bill only.
- Some order numbers are written with a hyphen. Lookups drop it, and the search does not find
  them without it.

## Numbers

CEVA's references take many forms: house bills of two or three letters and seven or eight
digits, order numbers of digits, and digits with a suffix after a hyphen. None of them points
to CEVA alone, so no rule claims them and a lookup needs the carrier named. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

CEVA Trak reads a reference from `reference_query` on its page, such as
`cevalogistics.com/en/ceva-trak`. CEVA Home Delivery's page reads it from `trackingID`, and the
older freight tracker on `etracking.cevalogistics.com` from `sv`.

## Testing

`npm run test:carriers:live -- carriers/ceva-logistics`, with `CEVA_LOGISTICS_TRACKING_NUMBER`
and optionally `CEVA_LOGISTICS_ORDER_NUMBER` and `CEVA_LOGISTICS_UNKNOWN_NUMBER` set outside the
repository.
