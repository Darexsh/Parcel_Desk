# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the service the tracking page asks:
one order with its status code and one wall clock per milestone, empty for a milestone it has
not reached. `delivered.json` went back to the warehouse after a first run and was delivered on
a second, so its return stamp is older than its out-for-delivery stamp; it carries a client's
name and order number, a delivery note, a return reason and a delivery photo's address.
`in-transit.json` is out for delivery after its collection. `not-found.json` is the answer for a
number the service holds no order under.

Numbers, names, notes, addresses and clocks are invented.
