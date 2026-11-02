# Fixtures

The pages follow the shape `teamexpressme.com/tracking?trackno={number}` renders: the tracking
form, then for a shipment a block headed with its airwaybill, with the summary table and the
scans newest first, each with a date, a 12-hour clock, a location, a status and its details.

- `delivered.html` is a domestic next-day delivery from the shipment's data to the delivery,
  whose summary gives the shipper's reference and who signed.
- `export-delivered.html` is an export whose scans stop at the hand-over to a partner abroad,
  with the partner's forwarding number and tracking link, and whose summary says delivered.
- `in-transit.html` is an export forwarded to its destination, whose forwarding number is its
  own airwaybill and whose link goes to a site no catalog carrier owns.
- `empty.html` is the form alone, which the tracker gives a number it does not hold.

Numbers, names, references, places and clocks are invented.
