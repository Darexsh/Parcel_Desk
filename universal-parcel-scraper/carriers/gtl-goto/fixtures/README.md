# Fixtures

Replies of the tracking page's lookup, `POST /api/csms/shipment/v2/shipment/tracking`.

`delivered.json` has the fields the page reads: the number as `awb` and each scan's
`date_time`, `status` and `hub_name`. Its history goes from the pickup to the delivery,
newest first, with clocks in UTC. The English labels give way to Indonesian sentences for the
last mile, one sorting-centre arrival is repeated, one hub is a `-` placeholder and one is
null, and the delivery names who took the parcel and a phone number.

`in-transit.json` follows an archived reply of GTL's earlier lookup, with a TKGTL number and a
`location` instead of `hub_name`, mostly empty. The parcel is between sorting centres.

`current.json` has the shape of the current lookup's reply: the shipment's summary, with the
sender and the receiver, then the history oldest first, each scan with its `status_code`, a
clock without an offset, its hub, the driver who handled it and the platform's metadata. The
first scan has an empty code, the courier's departure from the delivering hub and the run to
the address share `delivery_start`, and the delivery names who took the parcel and links a
photo.

`not-found.json` is the reply, with HTTP 422, for a number GTL does not know.

Numbers, names, phones, hubs and clocks are invented.
