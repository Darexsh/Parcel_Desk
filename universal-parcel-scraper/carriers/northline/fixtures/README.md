# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/track/v3/public/reference`: the
consignment's summary, then its milestones newest first by wall clock, each with the zone
abbreviation the reply calls `branch`. `delivered.json` goes from a booking in Queensland to a
delivery in New South Wales in summer, with a delivery run that came back to the depot and a
depot scan listed twice. `in-transit.json` waits at a Western Australian depot; an origin
update with a later wall clock comes before the depot arrival in the reply, although it is
earlier. `not-found.json` is the answer for a number the tracker does not know.

Numbers, account codes, references, suburbs, postcodes and clocks are invented.
