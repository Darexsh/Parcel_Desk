# Boxtal fixtures

Synthetic replies in the shape of `GET https://private-gateway.boxtal.com/v2.1/carrier/tracking/{reference}`.
References, carrier numbers, accounts, order references and places are made up.

- `delivered.json`: a booking of one Mondial Relay parcel, delivered, its scans newest first.
- `not-found.json`: the HTTP 404 reply for a reference the tracker does not know.
