# Fixtures

The replies of `GET https://api.packlink.com/v1/trackings/{reference}`. `delivered.json` is a
shipment of two parcels with the same scans, from a carrier waiting for the parcel to a failed
round and the delivery; one scan carries a place with a postcode and coordinates.
`in-transit.json` is a one-parcel shipment whose carrier tracks it under the Packlink reference:
a depot's receipt and a notice that the parcel has yet to reach the destination depot come under
Packlink's catch-all codes, and every scan carries the same town. `not-found.json` is the 404
body for a reference Packlink does not know.

References, carrier numbers, ids, places and clocks are invented.
