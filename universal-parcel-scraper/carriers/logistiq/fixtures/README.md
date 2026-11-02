# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/v1/order-details` with the fields
the tracking page reads: the summary, the order details, the current status and the scans,
oldest first. `delivered.json` goes from the booking to the delivery: the pickup scan names
the sender's address, a failed attempt with a phone number in its remark comes before the
second round, and the current status repeats the delivery. `in-transit.json` waits between two
hubs on its way to Saudi Arabia. `not-found.json` is the HTTP 400 answer for a waybill
Logistiq does not know.

Waybills, references, names, places, amounts and clocks are invented.
