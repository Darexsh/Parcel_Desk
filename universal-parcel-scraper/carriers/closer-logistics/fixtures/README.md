# Fixtures

Each fixture follows the reply of the lookup Closer Logistics' tracking page makes for one
number, `admin.closerlogistics.com/tracking/shipments/{number}`: the shipment with its type, its
shop, its recipient, its latest incidence and each package's statuses, newest first.

- `delivered.json` is a delivery that failed twice before it was delivered. The latest
  incidence gives the reason for the second attempt, and the shipment names whoever took it.
- `in-transit.json` is a delivery of two packages out for delivery, with the driver's position.
  Both packages went out at the same second.
- `pickup.json` is a return collected from the customer after a failed attempt and waiting to go
  back to the shop.
- `not-found.json` is the answer for a number the lookup does not know, with HTTP 404.

Numbers, names, phone numbers, addresses, coordinates, identifiers, reasons and clocks are
invented.
