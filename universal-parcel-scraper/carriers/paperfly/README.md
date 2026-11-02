# Paperfly

Paperfly is a Bangladeshi courier that picks up online orders from merchants, Daraz among them,
and delivers them, often cash on delivery, across Bangladesh through its own delivery points
and riders. Tracked through the lookup its public tracking page makes.

## How it works

1. `direct`: one `POST https://go-app.paperfly.com.bd/merchant/api/react/order/track_order.php?order_number={number}`
   with no body, as the tracking page asks it for the number in its address. It needs no
   cookie, token, key or browser. The JSON reply has the order's status and its history, newest
   first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The service finds a number only with the hyphens Paperfly writes in it, so the adapter puts
  them back between the parts of the number it was given.
- An unknown number is HTTP 400 with `{"error":"Data not found. Record:0"}`. Any other 400, a
  404 or a redirect is not an answer about the order.
- The tracker also finds an order by its merchant's own reference. The reply must name the
  number asked, as its order number or as that reference.
- Recognition makes the same request.

## Notes

- History clocks are Dhaka wall clocks without a zone. Paperfly's webhook examples pair the same
  clock with a UTC instant six hours earlier, and Bangladesh keeps one zone, so the times are
  returned at `+06:00`.
- The history lines carry wording, no codes. The order's `status` beside them sets the stage.
  A closed order's history can shrink to a single in-transit line; the status then stays the
  last text and the history is marked truncated.
- An invoice line, which bills the merchant after the delivery, has no stage.
- The rider's name and phone number at the end of the out-for-delivery wording are taken out,
  as are phone numbers and amounts of money anywhere else. A hold keeps its reason, in Bengali.
  The sender, the recipient, the package's weight, contents and cash amounts and the `rotp`
  field in the reply are not kept.
- An order found by its Daraz reference gives its own order number as the canonical number.

## Limitations

- No scan locations, weight, delivery estimate or proof of delivery.
- Closed orders keep few history lines.

## Numbers

Paperfly order numbers join four parts with hyphens: the booking date as day, month and
two-digit year, a serial of four to six digits, and two letter-digit pairs. Some, as in
Paperfly's webhook examples, start with `Z`. The references Daraz gives the parcels it hands
to Paperfly start with `PFL-BD-`, two letters and ten digits. `paperfly-1` claims those
references, `paperfly-2` the order numbers and `paperfly-3` the ones with `Z`. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The tracking box on paperfly.com.bd opens `go.paperfly.com.bd/track/order/{number}`, which
needs the number with its hyphens. The page's server answers with HTTP 404 for every order and
its script then shows the order, or an empty one for an unknown number.

## Testing

`npm run test:carriers:live -- carriers/paperfly`, with `PAPERFLY_TRACKING_NUMBER` and
optionally `PAPERFLY_UNKNOWN_NUMBER` set outside the repository.
