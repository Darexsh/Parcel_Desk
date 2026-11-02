# Fixtures

`delivered.json` and `in-transit.json` follow the reply of SEKO's `tracking-service/track/{number}`
lookup: the shipment's summary, then its milestones oldest first, with the newest record first
within a minute. `delivered.json` repeats a status change in another case, lists a delivery's
proof-of-delivery records after it and carries a signer, references and postcodes.
`in-transit.json` waits at the delivering terminal for an appointment and gives its weight in
kilograms. An unknown number is an empty HTTP 404, which the tests build inline.

Numbers, names, references, places, postcodes and clocks are invented.
