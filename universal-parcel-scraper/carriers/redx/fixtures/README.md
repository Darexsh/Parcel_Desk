# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/v1/logistics/global-tracking/{id}`:
the scans, oldest first, each with its English and Bengali wording, the parcel's status, its
group, the action and a UTC instant. `delivered.json` goes from the booking through two line-haul
legs to the delivery hub, a delivery run with the rider's name and phone number, a hold with its
reason, a second run naming the rider and the areas they serve, and the delivery, listed twice.
`in-transit.json` was booked on a day of October and has reached the central hub, where the
vehicle's arrival is recorded twice and the unloading and the transit share a moment.
`not-found.json` is the answer for an ID RedX does not know.

IDs, names, phone numbers, hubs, places and clocks are invented.
