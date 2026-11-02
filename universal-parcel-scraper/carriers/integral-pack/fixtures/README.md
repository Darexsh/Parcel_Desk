# Fixtures

Replies of the tracking page's lookup, `GET /api/seguimiento/buscar?codigo={guide}`, with the
current state, the guide and its parcels, and the events oldest first, as the service sends
them. `delivered.json` is a parcel the recipient collected at the destination agency, with a
repeated event and clocks with and without a fraction of a second. `in-transit.json` waits at
the destination branch for a delivery to the door, with no weight recorded. Both carry a
sender, a recipient, a delivery address and the agency's coordinates, which the adapter does
not keep. `not-found.json` is the answer for a guide the tracker does not know.

Guides, names, addresses, places, coordinates and clocks are invented.
