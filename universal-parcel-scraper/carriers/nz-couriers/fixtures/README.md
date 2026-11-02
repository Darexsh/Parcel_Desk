# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's
`tracking-events` lookup, oldest scan first as it lists them. `customer-label.json` follows the
reply of the receiver site's lookup with the sender's account.

`delivered.json` is a consignment tracked by its SSCC. A rural notice is repeated, New Zealand
Couriers hands the parcel over to a rural delivery partner, and the partner's delivery carries a
signatory's name, a signature and a delivery photo. `in-transit.json` is a courier ticket of two
parcels with a delivery estimate: two deliveries that did not happen, the parcel held at the
freight office and sent out again. The second parcel's label is created twice.
`customer-label.json` is a customer printed label asked with its sender's account: the label's
creation comes first and without a type, and is dated after the pickup.

An unknown number gets an empty HTTP 204 reply, so it has no fixture.

Numbers, names, places, branches, tags, links and clocks are invented.
