# Fixtures

The replies follow `GET /ecommerce/tracking/public/packages/{number}`, as the parcel page asks it.

- `in-transit.json` is a parcel Maersk carries in the United States and hands to Amazon. Maersk's
  scans state Central time's offset, Amazon's state UTC's. One of Amazon's scans is listed twice so
  the tests can show it is kept once. The client's order number and code and the destination's
  town are present so the tests can show they are left out.
- `delivered.json` is a parcel DPD delivers in Austria. DPD's scans state no offset.

An unknown number is a 404 with an empty body, so it has no fixture. Numbers, clocks, places and
the client's details are invented.
