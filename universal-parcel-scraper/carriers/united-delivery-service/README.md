# United Delivery Service

United Delivery Service (UDS) is a regional courier for same-day, next-day and routed
deliveries in Illinois, Indiana and Wisconsin, sorted at its Chicago-area hubs. Tracked through
its tracker's page for a barcode.

## How it works

1. `direct`: one `GET https://www.uniteddeliveryservice.com/track/barcode/{number}`, the page
   the tracking form opens. The tracker renders it on the server: the status, the barcode, a
   rail of four steps of which only the current one has a place and a clock, a delivery
   estimate, the parcel's weight and size, and the proof of delivery. It needs no cookie,
   token, CAPTCHA or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A barcode the tracker does not hold gets "Barcode Not Found" and a notice naming the number,
  or a plain page with the lookup form and "Barcode {number} Not Found". That notice is the only
  missing parcel. The tracker drops parcels after 30 to 90 days, by its own pages, so an older
  parcel is not found either. A redirect, a 404, a page without the status
  and a page for another number are no answer. Block pages are challenges, and rate limits and
  other HTTP errors keep their own failure kinds.
- The page must show the barcode asked.
- Recognition makes the same request.

## Notes

- The rail's earlier steps have no clock, so the result is the current step's scan alone and is
  marked `summary_only`, for a provider with a fuller history.
- A scan's clock is Chicago wall time to the second, named `CDT` or `CST`. It becomes an
  instant only when that name is Chicago's offset at that wall clock, which also tells the
  repeated autumn hour apart; any other clock stays `local_time`.
- The estimate reads like "Wed, Apr 1 by 8:00 PM", without a year. The day takes the one year
  near the lookup, within 45 days of it, on which it falls on that weekday; otherwise there is
  no estimate. The latest clock is not kept.
- The status heading stages the parcel before the step: it can name a delay, Will-Call or a
  return that the rail does not show. Wording the map does not know goes to the shared wording
  rules.
- The weight in pounds becomes kilograms; the size stays as shown, in inches.
- Where the parcel was left, the signature requirement, the delivery photo behind a ZIP code
  check, the delivery id and the issue form are not kept.
- The tracker has other lookups: `/track/api/isbarcode/{number}` says whether it holds a
  barcode, and `/track/api/orderref/{reference}` and `/track/api/deliveryNumber/{number}` look
  up shippers' references. The embeddable widget, `/track/include/extTracking.min.js`, reads
  `/track/api/barcode/{number}`, which answers with the former page's table of dated events
  and the destination's ZIP code. UDS also has an Android app. The adapter uses none of them.

## Limitations

- No history before the current step.
- The page shows the barcode as typed, so the check cannot tell whether the tracker matched the
  whole number.

## Numbers

The tracker takes the package barcode, which is often the shipper's own. UDS's own labels
carry two digits, `UDS` and eleven digits, or `APUDS` and eight digits;
`united-delivery-service-1` claims those layouts, which no other carrier uses. Other packages
keep the shipper's barcode: eleven, twelve or eighteen digits, `EZ` numbers from a shipping
platform, or references such as `BBC`, `DY` or `C` followed by digits. They name the shipper
or platform rather than UDS, or share their shape with many carriers, so no rule claims them.
A number filed under UDS reaches the adapter, which takes ten to forty letters and digits. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

Tracker pages are `uniteddeliveryservice.com/track/barcode/{number}`; the library reads the
number from that address.

## Testing

`npm run test:carriers:live -- carriers/united-delivery-service`, with
`UNITED_DELIVERY_SERVICE_TRACKING_NUMBER` and optionally
`UNITED_DELIVERY_SERVICE_UNKNOWN_NUMBER` set outside the repository.
