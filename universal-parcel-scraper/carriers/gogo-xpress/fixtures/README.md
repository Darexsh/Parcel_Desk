# Fixtures

Replies of the tracker's `/v1/track/{number}` lookup, in its own shape: the shipment's
attributes and its scans grouped by phase, oldest first within each. `delivered.json` goes
from the booking to the delivery through a hand-over to a delivery partner, whose scans were
recorded hours after they happened; a failed attempt comes before the delivery. Its rider and
courier, the person met, the item, the cash to collect and the proof of delivery are all in
it. `in-transit.json` has crossed to an island hub and carries a delivery estimate, a scan
repeated at the same second and a remark the carrier masks for the page. `not-found.json` is
the answer, with HTTP 400, for a number the tracker does not know.

Numbers, names, phone numbers, hubs, items, amounts, links and clocks are invented.
