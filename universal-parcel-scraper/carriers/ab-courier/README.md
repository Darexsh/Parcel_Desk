# A&B Courier

A&B Courier Service is a courier and freight company in Toronto and York Region, with
same-day, rush and overnight courier service in the Greater Toronto Area. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://abcourier.com/ABWebclientAPI/V1/Auth/TrackingInfo` with
   `{"accountNumber":0,"orderNumber":{number}}`, as the tracking page at
   `abcourier.com/CCWebClient/General/TrackingInfo/{number}` makes it for a visitor who is not
   signed in. It needs no cookie, token, key or browser. The JSON reply is the order's summary:
   its status, the pickup and delivery towns, the service, the pickup and delivery clocks, the
   estimate and the weight, with the step and wording of the picture the page shows over it.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An order it does not have is HTTP 200 with `statusCode` 300 and `Not able to find this order
  on our server.`, which the page shows as "Sorry, we could not find this order." Any other
  answer is inconclusive, and so is a reply for another order: nothing from it is kept. A
  redirect, a 404 or a 410 is a moved route.
- Recognition makes the same request.

## Notes

- Visitors get a summary, not a history. The result is marked `summary_only` and holds the
  status, the pickup once the status is past it and the delivery once the order is delivered,
  each at its town and province. Before the pickup, the pickup clock is the scheduled one, which
  is no scan and is not read.
- `Open`, `Assigned` and `Dispatched` come before the pickup, and statuses after it repeat
  `Picked Up` before the step. `Finalized` is a delivered order that is closed; `Cancelled` is an
  exception. The page's picture has five steps, from scheduled for pickup to delivered, and the
  reply names the step with each status: a status the map does not know takes it, and "almost
  there" counts as in transit. The picture's wording is the status text.
- The clocks come from A&B's dispatch system without a zone, and are its office's in Toronto.
  An order with both ends in Ontario has its clocks read as instants there. Any other order
  keeps wall clocks in `local_time`, and its estimate is a day.
- The estimate is the page's "Estimated Delivery By" until the delivery.
- The page links to Canpar, Purolator or FedEx tracking for an order handed to a driver it
  reserves for that carrier. The result names the partner and the barcode or waybill the link
  carries; a cancelled order has none.
- The service, such as `3:00 PM` for delivery by that time, and the total weight, which the page
  gives in pounds, are kept. The page also names who signed for the delivery and shows the boxes
  and their sizes; the reply adds the driver's number and the time the order was booked. None of
  them is read.

## Limitations

- No history between the pickup and the delivery, no sender or recipient.
- An order reaches the adapter when it is filed under A&B Courier or opened from an A&B link: a
  bare run of digits fits many carriers' references, so no rule claims it and preflight does not
  ask it.
- Order numbers run in sequence without a check digit, so a mistyped number can open another
  order, and the adapter cannot tell.

## Numbers

The tracker takes A&B's order number, a plain run of digits; archived lookups show seven-digit
orders. The tracking page reads the input as a whole 32-bit number, so it drops leading zeros
and ends at 2147483647. The adapter takes seven to ten digits up to that number, and refuses a
leading zero rather than look up the number without it. A&B's tracker names the signer of each
public sample, so [`numbers.json`](numbers.json) holds an invented order.

## Links

The tracking form on `abcourier.com` opens
`abcourier.com/CCWebClient/General/TrackingInfo/{number}`. Archived lookups also use the older
page `abcourier.com/tracking-info?tracking-number={number}`; the library reads the number from
either address.

## Testing

`npm run test:carriers:live -- carriers/ab-courier`, with `AB_COURIER_TRACKING_NUMBER` and
optionally `AB_COURIER_UNKNOWN_NUMBER` set outside the repository.
