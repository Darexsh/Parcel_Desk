# Fixtures

`page.html` is a cut-down tracking page that carries the lookup token in its `track-token` meta
tag. The JSON files follow the reply of the page's `/track/api`, newest scan first.

`delivered.json` goes from a new order and its assignment to a courier to the delivery, with
one depot scan repeated. `in-transit.json` reaches a depot in the hour the clocks repeat when
they go back. Both keep the masked recipient, the sender and the weight the reply carries.
`not-found.json` is the answer for a number the tracker does not know, and
`session-expired.json` the answer to a lookup without a valid session.

Numbers, names, places, tokens and clocks are invented. The scans after the assignment take the
wordings the tracker shows for its partners' scans.
