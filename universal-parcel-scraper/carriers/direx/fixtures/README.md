# Fixtures

Each fixture follows the reply of the lookup Direx's tracking page makes for one number,
`old.direx.bg/track/multiple?itemNumbers[]={number}`: a list of shipments, each with its
destination, the partner Direx handed it to with that partner's link and number, the product
and its statuses with the time each was added. The reply does not list the statuses in time
order.

- `delivered.json` is a parcel delivered by USPS, with a routing barcode as the partner's number.
  One status is listed twice and the delivery comes twenty-one minutes past midnight.
- `in-transit.json` is a parcel on its way with UPS.
- `returned.json` is a parcel UPS sent back, which Direx put in a dispatch to its sender.

An unknown number gets an empty list, so it has no fixture.

Numbers, partners' numbers, ZIP codes, identifiers and clocks are invented.
