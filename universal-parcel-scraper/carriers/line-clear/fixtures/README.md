# Fixtures

Each file follows the reply of Line Clear's `viewandtrack` lookup for one waybill: a list with
one list of scans, each naming the waybill, its code, status, branch code, wall clock and a
description naming the staff member who scanned it. `delivered.json` goes from the waybill's
creation through a station and an exchange hub to a failed delivery with its reason, a second
round and the delivery, with a scan the tracking page hides and a scan repeated.
`in-transit.json` has left the exchange hub. `not-found.json` is the answer for a number Line
Clear has no record of.

Numbers, branch codes, people, reasons and clocks are invented.
