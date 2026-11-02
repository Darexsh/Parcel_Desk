# Fixtures

Each page follows the tracker's result page (`linkView`) for one waybill, cut down to its two tables.

- `delivered.html` lists the scans newest first, from pickup to the recipient taking the parcel. The
  delivery and out-for-delivery scans name the courier with a phone number, as the tracker does, and
  the pickup appears twice, once without its time.
- `in-transit.html` stops at the first terminal, with an empty delivery result in the summary.
- `out-for-delivery.html` ends with the courier's delivery window, and its pickup has no time.
- `archived.html` is an old waybill whose scans carry their day without a time.
- `not-shipped.html` is a label known to the tracker without scans: its summary says 미출고.
- `not-found.html` is the answer for a waybill the tracker does not know: `***` for both branches.
- `rejected.html` is the answer for a number failing the check digit: no waybill in the summary.
- `maintenance.html` is the page the site shows while it is down.

Numbers, branches, terminals, names, phone numbers and clocks are invented.
