# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/track` in English, newest scan
first, each scan with its code, wall clock, zone and offset and the status the page names.
`delivered.json` is a summer history from the pre-alert to a mailbox delivery: the first
attempt fails, the parcel goes back to the depot, the recipient confirms the address in an
update message clocked in UTC, and one depot scan is repeated. `in-transit.json` is a winter
history that has reached the delivery depot. `not-found.json` is the answer for a number PDN
Express does not know.

Numbers, places, clocks and icon addresses are invented.
