# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/veloces/shipments/{guide}/tracking`:
the shipment record with its current status, its history oldest first, its origin, destination,
driver, payment and proof-of-delivery photos. `delivered.json` is collected, fails a first attempt
with the courier's reason and a remark naming the recipient, logs the destination warehouse twice
and is delivered on the second attempt. `in-transit.json` has left the destination warehouse
before its first attempt. `not-found.json` is the answer for a guide Veloces does not know.

Guides, names, addresses, phone and ID numbers, links and clocks are invented.
