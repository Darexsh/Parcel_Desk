# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracker's `general_sql` lookup: a
list with one shipment, its order and tracking numbers, the shipper's and recipient's
addresses, countries and states, the current milestone and the history as an XML string of
`<history>` elements, newest first, each with its milestone, wall clock and remark.
`delivered.json` goes from Malaysia to a delivery in the United States, with a scan listed
twice and clocks with a fraction of a second. `in-transit.json` has reached customs in
Australia, where the catch-all milestone carries the start of clearance in its remark.
`not-found.json` is the answer for a number the tracker does not know, and
`service-error.json` the service's own error, with its stack trace shortened.

Numbers, names, addresses and clocks are invented.
