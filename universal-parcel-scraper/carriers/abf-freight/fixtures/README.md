# Fixtures

Each file follows the shape of the reply `GET /api/nlo/track?ref={number}` gives without an
account: the number asked, with the shipments found under it. Numbers, places, addresses,
contacts, names, weights and clocks are invented.

- `delivered.json`: a delivered shipment whose delivering service center keeps Mountain time in a
  state that is mostly on Central time, with the signer in the status details.
- `transit.json`: a shipment at its destination service center with a projected delivery day,
  picked up at a center on Eastern time, its pickup clock labelled with Central's offset.
- `not-found.json`: the answer, with HTTP 404, to a number the service has no shipment for.
