# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `GetPackageTrackingDetailsByBarCode`,
newest scan first, with the shipment details the tracker reads. `delivered.json` goes from the
upload to the delivery: one hub scan is repeated, and the courier's scan carries a call with the
courier's name and phone number. `in-transit.json` waits at a hub with the delivery courier,
the address, the cash to collect and the preferred delivery time already filled in, and its
clocks carry no fraction, a short one and the longest the reply gives. `not-found.json` is the
answer for a barcode an instance does not know, and `failure.json` the answer of an instance
whose database is unreachable.

Barcodes, names, phone numbers, addresses, amounts and clocks are invented.
