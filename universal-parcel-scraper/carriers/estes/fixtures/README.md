# Fixtures

Each file follows the shape of the reply `GET /shipmenttracking/history?pro={number}` gives: `data`
with the shipment and its movements, each holding status rows, and `error` with the service's code.
PRO numbers, terminals, places, parties, references, coordinates and clocks are invented.

- `in-transit.json`: a pickup, an origin terminal, a waypoint in another time zone and the
  destination terminal, with an estimated day.
- `delivered.json`: a delivery on an appointment, with one row listed twice, the receiver's name and
  the delivery stop's place.
- `refused.json`: a refusal Estes files under its Delivered milestone, with its reason code and the
  exception flag.
- `not-found.json`: the HTTP 404 answer to a PRO number the service does not know.
- `invalid.json`: the HTTP 400 answer to a number that is not ten digits.
