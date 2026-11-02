# Fixtures

Replies of the lookup Domain Logistics' tracking page makes,
`api.domainlogistics.ca/domaintracking/api/tracking/{number}`, in the shape the page receives
them. Clocks, estimates and notes are invented.

- `delivered.json`: an Express Delivery order shipped, out for delivery and delivered, newest
  first, each status with its own estimate.
- `in-transit.json`: the same order just shipped, with an estimated delivery window.
- `service-error.json`: the HTTP 500 reply the service gives when it fails on a number.

An order the service does not hold is an empty HTTP 400, and one without a status yet an empty
array; the tests build both inline.
