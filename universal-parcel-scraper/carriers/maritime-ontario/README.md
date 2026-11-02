# Maritime-Ontario

Maritime-Ontario (M-O) is a Canadian less-than-truckload and expedited freight carrier. Tracked
through the TM4Web trace of its customer portal.

## How it works

1. `direct`: three requests, as the portal's trace page and the bill viewer it opens make them.
   It needs no account, key or browser.
   - `POST https://cp.m-o.com/trace/external_bill_viewer.msw` with the trace form's whole body:
     `trace_type[]` and `search_value[]` for each of its five types, the freight bill,
     `~PTLORDER`, filled in and the customer's trace number, bill of lading, purchase order and
     booking left empty. The viewer opens an anonymous session, sets its cookie and writes the
     search into its page.
   - `GET trace/bill_details_ajax.msw` with the same values, the types first, and
     `func=ExternalTrace`, in that session. The JSON reply is the bill's `DETAIL_LINE_ID`, the
     matches it found, or `{"NO_RESULTS":true}`.
   - `GET trace/bill_details_ajax.msw?func=BillDetails&dld={id}`. The JSON reply holds the order,
     `TLORDER`, and its status history, `ODRSTAT`.
2. `retry`: the whole sequence once more, in a new session, after a network failure or timeout.
   The first try gets half of the budget.

- An unknown freight bill is `{"NO_RESULTS":true}`. The trace gives the same answer to a request
  that leaves out one of the form's types, so both requests carry them all.
- Outside a session the portal sends a request to its home page, which is inconclusive. The bill
  details answer only for a bill the session's trace found.
- A 403 or a block page is a challenge. A 404 or a redirect of the viewer is a moved route.
  `customerportal.m-o.com` redirects to `cp.m-o.com`.
- When several bills answer, only the one whose number is the whole number asked is taken. The
  order's `BILL_NUMBER`, padded with spaces, must be the number asked.
- The requests and the parser are TM4Web's, in [tm4web.ts](tm4web.ts), for other carriers on
  the same portal to share.
- No detection rule offers M-O numbers, so the adapter has no recognition.

## Notes

- Each status has its TruckMate code, such as `DEPCONS`, which stages it, and its description,
  such as `DEPART CONSIGNEE`, which is its wording. The trace lists nine codes for its history;
  M-O's Track and Trace guide shows a few more from the customer portal.
- M-O has no delivery code of its own. Its guide's history and the trace's go from the arrival
  at the consignee to the departure from it, then the order's completion right after, which sets
  the delivery time. The departure from the consignee is the delivery.
- A dispatch can be the pickup's or the delivery's, and delivery appointments say nothing of
  where the freight is, so those codes have no stage.
- Clocks are wall clocks with no zone, so they stay `local_time`.
- The estimate is the scheduled delivery, `DELIVER_BY` to `DELIVER_BY_END`, as days, dropped
  after the delivery.
- The reply also holds the zones, the bill of lading and purchase orders, the service, the
  user who entered the order and the freight's pallets, weight and volume. None is kept. The
  trace hides the parties, the images and the carriers section, so there is no proof of
  delivery or hand-off.
- The quick-track form on `m-o.com` asks `api2.m-o.com/external/public/trackandtrace` for a
  summary: the current status and the truck's arrival at and departure from the shipper and the
  consignee, with no history. It takes bills of lading and purchase orders as well and is rate
  limited, so the adapter does not use it.

## Limitations

- The history has no location, and there is no time as an instant.
- Bills of lading and purchase orders, which the same form also takes, are not looked up: they
  are shippers' references.

## Numbers

M-O's Track and Trace customer guide shows a freight bill as a capital F followed by seven
digits, which the adapter accepts. A single documentation example is too little to claim the
shape, so no rule claims it, and the gap is declared in
[`gaps.json`](../../core/detection/gaps.json); a caller names the carrier. The sample and its
source are in [`numbers.json`](numbers.json).

## Links

The quick-track form takes the number in its address at
`www.m-o.com/quick-track-form/?t={number}` and looks it up on load. The form also takes bills of
lading and purchase orders, so the library reads no number from a link. The `/di/` portal needs
a login.

## Testing

`npm run test:carriers:live -- carriers/maritime-ontario`, with
`MARITIME_ONTARIO_TRACKING_NUMBER` and optionally `MARITIME_ONTARIO_UNKNOWN_NUMBER` set outside
the repository.
