# Fixtures

Cut-down pages of Evdemo Lojistik's tracker at `/takip?kargo_kodu={number}`: the search form,
then the shipment's number, its details and a table of its scans, newest first.

- `delivered.html`: a shipment of two packages, delivered after a failed round, in the current
  layout with the status headline, a row the page lists twice and a table per package.
- `returned.html`: a shipment on its way back to the sender and then handed back.
- `in-transit.html`: a shipment being carried, in the older layout with the progress rail's
  labels, no status headline and the older wordings.
- `not-found.html`: the notice for a number the tracker does not know, under the empty form.

Numbers, masked names, provinces, package contents and dates are invented.
