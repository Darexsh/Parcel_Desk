# Fixtures

Each page follows the shape of R+L's shipment tracing page, cut down to the parts the adapter
reads and the copies it leaves alone. Numbers, parties, references, places, dates and clocks are
invented.

- `delivered.html`: the result of a two-letter PRO from the pickup through two terminals to the
  delivery, oldest first as the page lists it, with one row repeated, a town written with a space
  before its comma, and the shipper, consignee, bill-to party and bill of lading number beside
  it.
- `delayed.html`: a nine-digit PRO the summary calls Delayed, with the delay row first, towns
  written without a space after the comma and an estimated delivery day in summer time.
- `not-found.html`: the result of a PRO R+L has no record of.
- `check-digit.html`: the search page R+L shows after refusing a PRO whose check digit fails.
