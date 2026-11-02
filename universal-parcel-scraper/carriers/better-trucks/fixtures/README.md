# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/tracking/{number}` for one
number, newest scan first, with the shipment's addresses and every field the tracker sends for a
scan. `delivered.json` goes from the label's creation to the delivery, in summer time: one hub
scan is repeated, the page's hidden creation row is there, a failed attempt and a return to the
station come before the delivery, and the delivery names who took the parcel, where it was left
and three delivery photos. `in-transit.json` is an underscore number at a hub in winter time.
`not-found.json` is the answer for a number Better Trucks does not know.

Numbers, names, places, coordinates, photo links and clocks are invented.
