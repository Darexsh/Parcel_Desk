# Averitt Express

Tracks Averitt Express LTL freight, the US less-than-truckload network, by its PRO number
through the direct tracking link Averitt documents for embedding.

## How it works

`GET https://tools.averitt.com/servlet/rsoLTLtrack?Type=PN&Number={PRO}` renders the shipment on
the server: its status, the pickup, shipment and delivery details, and the shipment progression.
The adapter reads that page with one GET. No account, cookie, key, CAPTCHA or browser is needed.
The tracker on averitt.com's home page and the LTL form open the same page. A request that fails
to reach Averitt is sent once more within the budget.

The page must name the PRO number asked. A number without a shipment comes back on the results
page with "Nothing found to display.", which is the only missing shipment; that page names no
number. A results page that lists shipments is inconclusive. Redirects, block pages and HTTP
errors keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Averitt PRO numbers are ten digits, leading zeros included, as Averitt's API guide and its
embedded-tracking page state. The adapter takes only that shape; anything else is invalid
without a request. Ten digits are shared by many carriers, so no rule claims them and a lookup
needs the carrier named.

## Notes

- Each progression row is a terminal's scan: the town and state, a clock and the status there.
  The page lists them oldest first.
- Clocks carry no zone and stay local times. The rows and the summary's pickup and delivery give
  the same clocks.
- The status over the page settles a delivery, a return or a problem, and a shipment without a
  staged row. Otherwise the newest staged row is ahead of it.
- "AT DESTINATION TERMINAL" after a delivery run that did not deliver says where the freight
  is, so it stays in transit.
- For older shipments the page keeps the summary but no rows. The pickup and, on a delivered
  shipment, the delivery then become the history, with the origin and delivery towns, and the
  result is marked `summary_only`.
- The page gives the weight without a unit; Averitt weighs freight in pounds, as its rate quote
  API guide states, so it is converted to kilograms.
- The shipper, consignee, who took the delivery, the BOL and PO numbers, the delivering service
  center, the piece count, the hazmat flag and the appointment are not read. Billing, charges,
  documents and invoices need an account.

## Limitations

No page of a shipment still on its way was seen live. Some row wording comes from archived
Averitt pages, and a status the map does not know falls to the shared wording rules. Order
numbers of Averitt's truckload, dedicated and other service units are not tracked. No estimated
delivery is read, and scans have no offset.

## Links

Averitt documents the link `tools.averitt.com/servlet/rsoLTLtrack?Type=PN&Number=` for a PRO
number.

## Live test

Set `AVERITT_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/averitt/adapter.live.test.ts`.
Optionally set `AVERITT_UNKNOWN_NUMBER` to check a PRO number Averitt does not know.
