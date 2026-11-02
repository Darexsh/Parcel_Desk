# Fixtures

Replies of the lookup ParcelPoint's tracking page makes,
`parcelpoint.com.au/wp-json/parcelpoint/v1/track?trackingId={number}`, in the shape the page
receives them. Numbers, points, carriers and clocks are invented.

- `collected.json`: a parcel a carrier delivered to a point, asked by its consignment id. It was
  booked to the point, made ready for collection and collected, newest first.
- `ready.json`: a parcel waiting at a point, asked by its booking code, with a reference. Its
  rows are out of clock order and one is repeated.
- `not-found.json`: the reply for a number the network does not hold.
