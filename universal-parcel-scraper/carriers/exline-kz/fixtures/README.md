# Fixtures

`delivered.json` and `in-transit.json` follow the shape of the tracking page's
`POST /api/v1/track/detail` reply: the order's number, codes, prices, weight, piece count,
delivery mode and planned day, the recipient's town, postcode and delivery note, the courier,
the courier's position, the current status and the status history in the order MeaSoft
recorded it, each scan with its wall clock, branch, town, note and status.

- `delivered.json`: a parcel sent between two cities and delivered on a second round, with
  scans that share a second and the recipient's name in the delivery's note.
- `in-transit.json`: a parcel sent from its first branch, with a planned delivery day, a repeated
  scan, a delivery instruction and the courier's position.
- `not-found.json`: the error body, with HTTP 502, the lookup returns when MeaSoft has no order
  under the number.

Numbers, codes, names, places, phones, coordinates, prices, clocks and the trace id are invented.
