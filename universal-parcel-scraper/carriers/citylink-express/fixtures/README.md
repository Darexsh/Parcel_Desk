# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `getTracking` for one number, with
the fields City-Link sends for the shipment and each scan, oldest scan first. `delivered.json`
crosses from Singapore to a Malaysian town. Its shipper's record has no location, its courier
and delivery scans name people as the tracker words them, one problem scan carries a disposal
code, and one scan is repeated. `in-transit.json` is a domestic parcel with one child piece,
whose shipper's record carries the `SR - ` prefix the page drops. `not-found.json` is the HTTP
404 body for a number City-Link has no record of.

Numbers, names, places, weights and clocks are invented.
