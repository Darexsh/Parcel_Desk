# Fixtures

- `delivered.json`: a delivered `detail.json` module (four scans up to `GTMS_SIGNED`, a bracketed town on the delivery and out-for-delivery scans, an ETA window, a partner handoff number, and a recipient block the adapter must ignore).
- `in-transit.json`: the same module mid-journey, line-haul scans only, with an open ETA window.
- `delivered-dofr.json`: a synthetic Cainiao-issued module for automatic detection and direct retrieval.
- `express-in-transit.json`: a Cainiao Express `queryDetail` reply for a partner's home-delivery parcel, wrapped in `data`, with a `location` on each scan: towns and a country code.

All are constructed from the response shape; every identifier, name, address and time is synthetic. Scans keep their `timeZone`; the first two include the Beijing-based epoch `time`.
