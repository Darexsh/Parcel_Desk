# Dohrn Transfer

Dohrn Transfer is a less-than-truckload freight carrier in the US Midwest. Since its merger with
Sutton, one Dohrn PRO covers freight moved by either company. Tracked by PRO through the XML
trace its API page documents.

## How it works

1. `direct`: one `GET https://facts.dohrn.com/scripts/cgiip.exe/protracexml.htm?pronum={PRO}`,
   the trace Dohrn's API page gives shippers. It needs no cookie, token, account or browser. The
   reply is an XML document labelled ISO-8859-1: the shipment with its lifecycle and its
   history, newest first, or an error naming the number.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The shipment's `pronumb` must be the PRO asked. Dohrn's tracking system looks for a bill of
  lading when no shipment has the number, so a shipment found another way is inconclusive and
  nothing from it is kept.
- "Invalid pronumber" followed by the PRO asked is the only missing shipment. The trace gives the
  same answer for a purged shipment. An error naming another number, a redirect, a 404, an empty
  reply and a block page keep their own failure kinds, and the error page of the WebSpeed broker
  behind the trace is inconclusive.
- A rate quote filed under the number, with the `Quote` lifecycle and no history, is not a
  shipment and is inconclusive.
- The adapter sends whole PROs only. The trace's lookups by bill of lading, purchase order and
  connecting-line number are not used.
- Recognition makes the same request.

## Notes

- Each history row has an ISO date, a 24-hour time, the action and a remark. Clocks carry no zone
  and the network spans two time zones, so they stay local times. A row whose time is blank
  keeps its day.
- A remark shaped as a town and its state is the row's place. "In Transit", "Customer Care
  Center" and "Delivering Terminal" name none.
- Dohrn's tracking page leaves out the "Manifested" rows, whose place can be another terminal
  than the one holding the freight, and the "En-route" row between "Out For Delivery" and
  "Delivered". The adapter leaves them out too. Repeated rows appear once.
- The lifecycle settles a delivery, a return or a problem, and a shipment without a staged row.
  Otherwise the newest staged row is ahead of it. Replies without a lifecycle fall back to the
  delivery flag.
- The estimate is the trace's estimated delivery day, else the day of the newest "Appointment
  Set" row. It is dropped once it is behind the history or the freight is delivered.
- The weight is given in pounds and kept in kilograms.
- The reply names the shipper's and consignee's towns, ZIP codes and terminals, holds the bill of
  lading, purchase order and quote number, the pallets and pieces, and gives the delivery's
  clock, its status and the signer, whom the summary status names too. None of them is read.

## Limitations

- No offsets, no delivery time as an instant, no sender, recipient or proof of delivery. Dohrn
  links scanned documents only for shippers tracking with their account.
- A PRO reaches the adapter when it is filed under Dohrn or opened from a Dohrn link: its digits
  are shared by many carriers, so no rule claims them and preflight does not ask it.
- Dohrn's PROs run densely, so a mistyped PRO can open another shipper's shipment or rate quote.
  For that reason no synthetic number checks Dohrn's tracking links.

## Numbers

Dohrn tracks freight by its PRO, eight to ten digits. The trace reads a PRO as a number and drops
leading zeros, so the adapter takes eight to ten digits that do not start with 0. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

Dohrn's API page tells shippers to append the PRO to
`facts.dohrn.com/scripts/cgiip.exe/protraceext.htm?wpro=`, which opens one shipment, and
documents the XML trace that takes it as `pronum` on `protracexml.htm`. The search box on
`dohrn.com` sends any reference as `referencenumber` to `shipmenttrace.htm` on the same host.
The library reads the number from each form.

## Testing

`npm run test:carriers:live -- carriers/dohrn-transfer`, with `DOHRN_TRANSFER_TRACKING_NUMBER` and
optionally `DOHRN_TRANSFER_UNKNOWN_NUMBER` set outside the repository.
