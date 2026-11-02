# Fixtures

The fixtures follow the reply of `GET /api/v2/tracker/related-updates/?tracking_nos={number}`,
which Janio's tracking page reads: a list with an entry per parcel, each with its status
updates newest first and its partners' references. `delivered.json` goes from Singapore to
Thailand, from the order and a first-mile pickup through the flight to the delivery partner's
scans, one of them repeated, and the delivery; its recipient's masked email and shortened
address are in the reply. `in-transit.json` has the parcel asked, from Hong Kong to Singapore
after a failed pickup and the flight, with an SPX reference, after a related order.
`not-found.json` is the answer for a number Janio does not know.

Numbers, references, emails, places and clocks are invented.
