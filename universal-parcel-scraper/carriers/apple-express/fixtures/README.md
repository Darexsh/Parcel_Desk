# Fixtures

Replies of Apple Express's tracking API, `trackapi.appleexpress.com/api/track`, in the shape
its tracking page receives them. Numbers, references, places, clocks and contacts are invented.

- `delivered.json`: `order/{number}/language/en` for an order under a shipper's APPL reference,
  newest first. It crossed the country, missed a delivery for want of a buzzer code and was
  delivered on the next round. The depot's scans are out of clock order as in Apple Express's
  replies, one row names its zone, one is repeated, one place carries a postcode, and the
  notifications and delivery instructions sit beside the scans they follow.
- `in-transit.json`: the same lookup for an order under a Cainiao reference, on its way to the
  destination depot, with its estimate and one row in a named zone.
- `orders.json`: `trackmultiple/{reference}/language/en`, the list of orders a reference names,
  for the reference in `in-transit.json`.
- `not-found.json`: the reply for a number Apple Express does not know.
