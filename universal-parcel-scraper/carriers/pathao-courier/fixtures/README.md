# Fixtures

`delivered.json`, `in-transit.json` and `returned.json` follow the reply of `/api/v1/user/tracking`
for a consignment ID sent without a phone number: the order's summary, the tracking page's rail
state and the scans, oldest first, each filed under its step. `delivered.json` goes from the pickup
request to the delivery; a rider is named for the pickup and, with a phone number, for the
delivery, a weight correction shares its minute with the pickup hub's scan, the delivery is
listed twice, and the order carries the rider, the contents and the amounts. `in-transit.json`
has left the central sorting hub, with the delivery estimate the reply gives. `returned.json`
uses the older wording, with the rider's name, staff code and phone number in brackets, a hold
at the delivery hub and staff notes naming people. `not-found.json` is the answer for an ID
Pathao does not know.

Numbers, names, phone numbers, places, amounts and clocks are invented.
