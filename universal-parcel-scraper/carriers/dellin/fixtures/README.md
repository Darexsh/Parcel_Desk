# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `POST /v3/orders.json` to a guest,
with the parties and the cargo left empty as the API leaves them. `delivered.json` is a finished
order with two waybills: its milestones go from the sending terminal to delivery to the address,
and two milestones for the papers have no date yet. `in-transit.json` is an order looked up by
its pickup request, collected from the sender and on its way; one milestone is a forecast.
`not-found.json` is the HTTP 400 answer for a number Dellin has no order for.

Numbers, places, dates, sums and terminal details are invented.
