# Quiqup

Quiqup is a Dubai courier that collects online shops' orders, or fulfils them from its own
warehouse, and delivers them across the United Arab Emirates the same or the next day. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://ex-api.quiqup.com/order_management/tracking?order_id={number}`, as
   the tracking page on `track-parcel.quiqup.com` sends it for an order number typed in. It needs
   no cookie, token, key or browser. The JSON reply has the order's current state, the time the
   order entered each state, oldest first, and the time it is due by.

- An unknown number is HTTP 422 with `{"error":"Incorrect order id or phone number"}`. Another
  422 is a refused request, and a 404 or a redirect is a moved route.
- The order must echo the number asked.
- There is no recognition: the numbers are bare digit runs no rule claims, so preflight would
  not ask Quiqup.

## Notes

- Every state change carries its offset, so scans are instants rather than Dubai wall clocks.
- A scan's description is its state's name in words, such as `At depot`. The page groups the
  states under fewer labels, showing `at_depot` as Collected and `return_to_origin` as
  Cancelled; the state names keep the difference, and [`statuses.json`](statuses.json) records
  each label.
- The order's current state decides its stage. A courier who cannot collect the parcel moves
  nothing, so that state has no stage.
- The estimate is the end of the delivery window, which the page shows until the order is
  delivered, held, missed, cancelled or returned. A customer's return the courier collects gets
  none.
- On the page, the order's phone number opens a card with the delivery address, the courier,
  the payment and the delivery code. The adapter never sends a phone number. The reply to the
  number alone has the merchant's own order number, which is not kept.
- A parcel Quiqup hands to another carrier has that carrier's tracking number on the page's
  detailed tracking card, from a separate shipments call. That call fails for orders Quiqup
  delivers itself, and the adapter makes no hand-off.

## Limitations

- No scan location, weight, sender or service name.
- A robot delivery's step with the robot, which the page adds from the robot's own record, is
  not read.

## Numbers

Quiqup order numbers are a sequence of seven digits on older orders and eight now. Detection
does not claim them, because many carriers print bare digit runs. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The page's address `track-parcel.quiqup.com/{number}` names the order number, which the library
reads. Quiqup's own tracking links open an order by an unguessable key instead, from which it
reads no number.

## Testing

`npm run test:carriers:live -- carriers/quiqup`, with `QUIQUP_TRACKING_NUMBER` and optionally
`QUIQUP_UNKNOWN_NUMBER` set outside the repository.
