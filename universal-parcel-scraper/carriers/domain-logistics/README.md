# Domain Logistics

Domain Logistics is the Toronto logistics provider behind Domain Express, the direct-to-door
Same-Day and Express Delivery of Ontario Cannabis Store orders. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://api.domainlogistics.ca/domaintracking/api/tracking/{number}`, the
   lookup the tracking page on `domainlogistics.ca/tracking/` makes for the number typed in. It
   needs no cookie, key or browser. The JSON reply is the order's statuses, newest first, each
   with its delivery service, estimate, clock and a note.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An order the service does not hold is an empty HTTP 400, which the page shows as an invalid
  tracking code; the adapter reports it as not found. A 404 is a moved route.
- An empty array is an order without a status yet, which the page asks to check again later:
  no history, not a missing order.
- The service fails on some older orders with HTTP 500 and `{"Message":"An error has
  occurred."}`, while an unknown number gets its 400, so that reply is inconclusive.
- Cloudflare sits in front of the service: its browser check is a challenge and its 429 a rate
  limit.
- The reply never repeats the number. The path carries it whole and the service matches it
  whole, so a number missing a digit or with a leading zero added or removed is unknown to it.

## Notes

- A status's `Date` is the day and a twelve-hour clock with no zone. The clocks are not UTC: an
  archived reply lacks a status the service now stamps with a clock that, read as UTC, comes
  before the reply was archived. They read as Ontario's, where Domain delivers, but the reply
  names no zone, so they stay `local_time`.
- Each status carries its own `Estimated`: a day with the delivery window once the order ships,
  then an arrival time when it is out for delivery. Those clocks have no zone either, so the
  estimate is the newest status's day, dropped once the order is delivered or the day has
  passed.
- `Service`, such as `Express Delivery`, is the service name. The `Note` beside a status is the
  page's advice about the estimate and is not kept.
- The page writes each value in as HTML; the adapter keeps the text.
- The French page asks `/api/tracking/fr/{number}`, which gives the same statuses in French.
  The adapter asks for English; the status map knows both.

## Limitations

- No scan locations, proof of delivery or delivery times as instants.
- Orders the Ontario Cannabis Store sends by Canada Post are tracked by Canada Post.

## Numbers

Lookups on the tracking page and its service carry twelve-digit numbers. The tracking form's
example has nine letters and digits, a layout no lookup shows, so its record stays in
quarantine. Twelve digits are shared with many other carriers, so no rule claims them, and
recognition does not ask Domain. The adapter takes letters and digits with a digit and leaves
the layout to the service. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from its `tracking` parameter, on
`domainlogistics.ca/tracking/` and on the French page under `/tracking/fr/`, and looks it up on
load. The library reads the number from either page.

## Testing

`npm run test:carriers:live -- carriers/domain-logistics`, with
`DOMAIN_LOGISTICS_TRACKING_NUMBER` and optionally `DOMAIN_LOGISTICS_UNKNOWN_NUMBER` set outside
the repository.
