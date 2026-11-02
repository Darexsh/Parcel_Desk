# Fixtures

Replies of the history lookup Quicksilver's tracking page makes,
`GET /v1/customer/tracking/history?tracking_number={number}`: the number, the delivery
driver's mobile number and the statuses, mostly newest first, each with its name, a reason, a
proof-of-delivery photo and its clock.

- `delivered.json`: a parcel ordered, collected and delivered, with a status the service
  lists twice at the same clock and a `Picked` status listed with the earliest clock.
- `in-transit.json`: a parcel received at a station and ready for dispatch.
- `not-found.json`: the HTTP 404 reply for a number the service does not know.

Numbers, phone numbers, stations, clocks and photo addresses are invented.
