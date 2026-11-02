# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the lookup's
`/api/v2/client/public/services/shipment/{number}/history`, newest scan first, with the
shipment's summary fields. `delivered.json` goes from the pickup to the delivery: the summary
names a consignee and the recipient's city and province, the delivery scan's reference names
who took the parcel, one hub scan is repeated and one row has no status, which the page leaves
out. `in-transit.json` waits at a hub after a pickup whose reference names the seller.
`not-found.json` is the body that comes with HTTP 404 for a number the lookup does not hold.

Numbers, names, places, IDs and clocks are invented.
