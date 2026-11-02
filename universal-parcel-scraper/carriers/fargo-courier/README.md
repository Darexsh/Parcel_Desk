# Fargo Courier

Fargo Courier delivers parcels and documents between its branches across Kenya, with a hub in
Nairobi and overnight linehauls between branches. Tracked through the tracker its home page
frames.

## How it works

1. `direct`: one `GET https://portal.fargocourier.co.ke/track?blank=1&wayBillNumber={number}`,
   the page the home page's form frames and the customer portal's search opens. It needs no
   cookie, token or browser. The HTML page has the waybill's summary, its proof of delivery, the
   sender and receiver, and the waybill's events, newest first.
2. `retry`: the same request once more after a network failure or timeout. The first try gets
   half of the budget.

- The tracker answers a waybill it does not have with its generic error page and HTTP 500,
  "We could not complete your request", as it answers its own failures. That reply is
  inconclusive, so no lookup ends as not found. A 404 or a redirect is a moved route.
- The page must name the waybill asked, in any case. The tracker also finds a waybill by its
  parcels' label numbers, and that answer is inconclusive too.
- No recognition: the tracker cannot tell an unknown waybill from its own failure.

## Notes

- Each event has a code, such as `WBLDLV`, which stages it, and the branch code it was logged
  at, such as `HDO` for the Nairobi hub. Fargo's branches are all in Kenya, which keeps one
  offset all year, so the clocks are read in Nairobi time. A history with an event anywhere but
  a branch code keeps its wall clocks.
- The event text comes in lines of sixty characters, which are joined, and is cut short on some
  events.
- The waybill's invoicing to the sender's account is billing, not a scan, and is dropped.
- Only the events are kept: the service code, weight, parcel count, sender's reference, sender,
  receiver and proof of delivery are not.

## Limitations

- No estimate, and no delivery time but the delivery event's. In some histories that event is
  logged exactly an hour before the proof of delivery, whose own delivery time agrees with the
  proof; each clock is kept as given.
- Only waybill numbers are tracked, not a parcel's label number.

## Numbers

Older waybills have seven digits and later ones `FCLIN` and eight digits, which the tracker
matches in either case. `fargo-courier-1` claims `FCLIN` and eight digits, a prefix no other
carrier prints. No rule claims the seven-digit waybills, a bare digit run many carriers share.

## Links

The home page's tracking form sends the number as `wayBill` to `/waybill-viewer/`, so
`fargocourier.co.ke/waybill-viewer/?wayBill={number}` opens one waybill, as does the tracker's
own `portal.fargocourier.co.ke/track?wayBillNumber={number}`. The former tracker took it as
`waybill_number`, on `/track-your-parcel` and on the home page.

## Testing

`npm run test:carriers:live -- carriers/fargo-courier`, with `FARGO_COURIER_TRACKING_NUMBER` and
optionally `FARGO_COURIER_UNKNOWN_NUMBER` set outside the repository.
