# SkyPostal fixtures

Opened replies of the gateway behind SkyPostal's tracking page, in the shape it seals them. Every number, place, comment and label is invented.

- `delivered.json`: an `asyncSingleTracking` reply for a parcel from the Miami hub to its delivery by a destination partner, with SkyPostal's own label on the hub scans and the number asked on the partner's.
- `in-transit.json`: an `asyncSingleTracking` reply for a parcel in customs whose scans carry only SkyPostal's own label.
- `summary.json`: the `shipmentSearchMultipleSkp` summary that names the in-transit parcel's number.
- `not-found.json`: the reply for a number the tracker does not know, error 10001.
