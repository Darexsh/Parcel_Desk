# Fixtures

Each fixture is a body of `GetNewDeliveryTracking` as the page method returns it: ASP.NET's `d`,
the relay's `Data` and its `PayLoad`, each a string of JSON. `delivered.json` has an order with
its customer, sender, recipient, phone and prices, and milestones newest first from the guía's
creation to the delivery: the inventory scan is repeated, and the delivery has a proof of delivery
and a description naming the recipient with a phone. `in-transit.json` waits in a facility's
inventory after a transfer. `not-found.json` is the 404 result for a guía the tracker does not
know.

Guías, names, phones, prices, ids and clocks are invented.
