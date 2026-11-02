# Fixtures

`delivered.json`, `in-transit.json` and `closed.json` follow the opened reply of
`historialClOfs`: the order's summary, with the recipient's and sender's details masked as the
service masks them, and per package its days of scans, oldest first. `delivered.json` has two
packages scanned a minute apart at one hub, a failed home delivery, the waiting notes the system
adds while a parcel sits at the branch, and the delivery. `in-transit.json` is one package on
its way to a pickup branch, with the page's estimate. `closed.json` is an order closed as lost
after a claim, its last scans logged under `CONTACTO/TERMINO`. `not-found.json` is the 404 body
for a number Starken has no order under.

Numbers, names, branches, barcodes, clocks and amounts are invented.
