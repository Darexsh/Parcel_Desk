# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/shipment-itemId/{number}`, oldest
scan first, with every field each scan repeats. `delivered.json` is an Amazon parcel in winter:
a manifest row whose two clocks agree, a terminal scan, two out-for-delivery scans and a delivery
to a mailroom after midnight UTC, with a signer, a signature, a delivery photo, a driver's comment
and coordinates. `in-transit.json` is a shipping platform's parcel in summer: a manifest row, a
first-mile pickup, a terminal scan the reply repeats, a route transfer no map names and the
out-for-delivery scan. `not-found.json` is the 404 reply for a parcel id Precision does not hold.

Numbers, references, names, addresses, phones, accounts, routes, images and clocks are invented.
