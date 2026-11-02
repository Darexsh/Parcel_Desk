# Fixtures

Cut-down pages of ViaDireta's tracker at `/tracking?codigo={number}`, asked in Portuguese: the
form, then the shipment card and its movements, or the notice in their place.

- `delivered.html`: a parcel registered, taken into the warehouse, given a delivery day, sent
  out and delivered, newest first, with two movements on one clock.
- `unavailable.html`: the notice the page shows for a number it cannot show, with the comment
  beside it that its API returned an unexpected error. A made-up number gets it.

Numbers, clocks and tokens are invented.
