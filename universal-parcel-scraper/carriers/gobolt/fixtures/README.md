# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `bolt_shipping_labels/search`: the
summary, the steps of the page's progress rail and the parcel's steps, newest first.
`delivered.json` goes from the order to the delivery: a missed visit, whose place is an
address, sends the parcel back to the warehouse for a second run, and one step is listed twice.
`in-transit.json` is out for delivery. `not-found.json` is the HTTP 404 answer for a number
GoBolt does not know.

Numbers, places and clocks are invented.
