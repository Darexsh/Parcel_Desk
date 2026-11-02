# Fixtures

The found replies follow the shape of the tracking service's `GET /api/v1/rastrear-paquete/{code}`
reply: the item under `envio`, with its code, class, weight, origin and destination, the summary
message, and its scans newest first, each with its IPS event type, clock, wording, office, reason
and action.

- `delivered.json`: a domestic parcel posted at one office and delivered at another.
- `in-transit.json`: a domestic item between offices, without a summary message.
- `inbound.json`: a letter from abroad under its origin code, without a destination, handed to
  the delivery agent twice.
- `not-found.json`: the RFC 7807 problem the service answers with HTTP 404 for a code it does not
  know.

Codes, classes, weights, offices, clocks and the trace id are invented.
