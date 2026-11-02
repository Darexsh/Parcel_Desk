# Fixtures

Each fixture follows Tgroup's tracker page for one number, `/ttnet/traccia_spedizione/{number}`,
without its styles and script list: the scans tab, oldest first, each with its wording, clock
and branch, then the shipment tab's details boxes.

- `delivered.html` is a shipment delivered in winter. The pickup's round is assigned before the
  shipment is created, one scan is listed twice and the delivery round's scan names no branch,
  as on the tracker.
- `in-transit.html` is a shipment waiting for its delivery to be booked by phone in autumn,
  with two scans of one minute and one in the hour Rome's clocks repeat.
- `not-found.html` is the tracker's notice for a number it holds no shipment for.

Numbers, branches, towns, postcodes, weights and clocks are invented.
