# Pitt Ohio

Tracks Pitt Ohio LTL freight, the US Mid-Atlantic and Midwest less-than-truckload carrier, by its
PRO number through the shipment tracing page on pittohio.com.

## How it works

`GET https://pittohio.com/myPittOhio/Shipping/LTL/TraceRequest?pro={PRO}` renders the shipment on
the server: the current status and the shipment history. It is the page the site's tracing form
and its quick trace box open for one PRO number. The adapter reads it with one GET. No account,
cookie, token, CAPTCHA or browser is needed. A request that fails to reach Pitt Ohio is sent once
more within the budget.

The page must name the PRO number asked. A number without a shipment comes back on the search
form with "Search returned no results.", the only missing shipment, and the form keeps the number
it looked up in its first field, which must be the number asked. A results page that lists several
shipments is inconclusive. Redirects, block pages and HTTP errors keep their own failure kinds.
Recognition uses the same lookup.

The tracing form also searches by bill of lading and pickup numbers; the adapter asks for PRO
numbers only. Pitt Ohio's B2B tracing and image services need an identifier Pitt Ohio issues to
each customer, so they are not used.

## Numbers

Pitt Ohio tracks shipments by PRO number. The PRO numbers seen are ten digits, the length of the
PRO field of Pitt Ohio's bill of lading API, and the adapter takes only that shape; anything else
is invalid without a request. Aggregator samples all start with `504`. Ten digits are shared by
many carriers and the prefix rests on aggregator samples only, so no rule claims them, preflight
does not ask the adapter and a lookup needs the carrier named.

## Notes

- Each history row is a scan: a date, a time and the status, newest first. Clocks carry no zone
  and stay local times.
- A row's status can end with its place, "in" and a town and state. That place becomes the scan's
  location and the rest is its wording, so one wording covers every town. A terminal's place is
  its name, as the page shows it, which opens a pop-up with the terminal's address and phone
  numbers; the pop-up is not read.
- The status over the page settles a delivery, a return or a problem, and a shipment without a
  staged row. Otherwise the newest staged row is ahead of it. Without rows, the status and its day
  become the history and the result is marked `summary_only`.
- "Arrived at shipper pickup location" is the driver at the shipper, before the freight is
  collected; "Pickup - Departure" is the collection. "Scheduled for Delivery to Consignee" comes
  before each delivery run and moves nothing.
- The appointment section is not read. Delivery receipts and other documents need an account.

## Limitations

No estimate is read, and scans have no offset. Pitt Ohio warns that shipments from New York
State may have limited tracking.

## Links

Addresses archived from Pitt Ohio's site put a PRO number in `?pro=` on
`pittohio.com/myPittOhio/Shipping/LTL/TraceRequest`. The library reads the number from that
address.

## Live test

Set `PITT_OHIO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/pitt-ohio`. Optionally set `PITT_OHIO_UNKNOWN_NUMBER` to
check a PRO number Pitt Ohio does not know.
