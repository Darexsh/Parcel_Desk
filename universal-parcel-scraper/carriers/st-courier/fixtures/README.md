# Fixtures

The pages follow the tracker's `stcourier.com/track/shipment` result page, cut down to its tracking
form, its summary table, the timeline of scans newest first and the complaint form's prefilled AWB
and booking date. As on the live page, the timeline's class names are random strings.

- `delivered.html` is a consignment the page has no booking for: its summary shows "In Transit"
  with empty fields, while its scans go from hub to delivery. It has a repeated hub scan, a scan
  just after midnight, and a delivery that names who took the parcel and carries a phone number.
- `booked.html` is a booked consignment whose summary says delivered, with its booking branches,
  its booking and delivery times, and a single hub scan.
- `in-transit.html` is a consignment between hubs, under the unbooked summary.
- `not-found.html` is the page's answer for a number it has no consignment for, naming the number.

The lookup's JSON replies, a browser check and the other failures are built inline in the tests.

Numbers, names, phone numbers, branch codes, places and clocks are invented.
