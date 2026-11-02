# Fixtures

These follow the reply of the tracking page's `/api/tracking-order`, the shipment under `dist`
with its scans newest first. `delivered.json` goes from the merchant's warehouse to the delivery,
with a failed attempt, a hub scan listed twice and a code the page leaves out of the history; it
carries a customer's name and the merchant's name in its first scan. `in-transit.json` waits for
a rider at the delivering hub. `no-history.json` is a former Call Courier consignment the tracker
knows without scans, and `not-found.json` the answer for a number PostEx does not know.

Numbers, names, stations, places and clocks are invented.
