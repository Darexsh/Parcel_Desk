# Fixtures

Each file follows the reply of `api/web/V2/Consignments/Basics`, the lookup CCFS's shipment page
makes, with the history oldest first.

`delivered.json` goes from the bill of lading to the delivery, with the progress rail complete.
It carries the shipper's and the consignee's towns with their ZIP codes, the delivery's signer and
comment and a proof of delivery image, repeats one row, places one row with a ZIP code and has
system rows whose clocks carry a fraction, as replies do. `in-transit.json` is on a dock on its way,
with a delay notice as its newest row and a delivery window ahead. `not-found.json` is the HTTP 404
answer for a number CCFS does not know.

Numbers, names, places, ZIP codes, comments and clocks are invented.
