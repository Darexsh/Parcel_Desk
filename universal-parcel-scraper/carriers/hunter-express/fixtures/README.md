# Fixtures

Cut-down pages of Hunter Express's tracker at `/Track/55010/{number}`: the heading with the
current status, the consignment's details, the driver's last reading and the delivery's
details, and the history table, oldest first. Grouped scan rows carry their scans' UTC ticks
in the address of their detail panel.

- `delivered.html`: a consignment picked up, scanned into a depot, held for the next run, out
  for delivery and delivered.
- `in-transit.html`: a consignment out for delivery, with the heading's newer "Left Depot"
  status, a two-day estimate, the driver's position in the queue and an authority-to-leave
  note. Its out-for-delivery row falls on the previous day in UTC.
- `not-found.html`: the empty form with "Missing or incorrect tracking number".

Numbers, consignment ids, names, notes, suburbs, postcodes, places, coordinates, ticks and
clocks are invented.
