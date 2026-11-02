# Posti fixtures

Each file is a `SearchShipments` answer following the public tracker's GraphQL shape and
English wording. Every identifier, time, measurement, place, address and private-field
sentinel is synthetic; no captured response or session token.

- `delivered.json`: a parcel arriving in Finland, collected from a service point.
- `ready-for-pickup.json`: a parcel waiting in a public parcel locker.
- `delivered-abroad.json`: a parcel sent abroad, whose scans there read "ULKOMAILLA".
