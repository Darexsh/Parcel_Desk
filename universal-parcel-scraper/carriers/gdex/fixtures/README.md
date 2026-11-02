# Fixtures

Each file follows the reply of the GDEX app's `/api/trackings?search=` for one number: one entry
with the number, its validity and its record, scans newest first. `delivered.json` goes from the
pickup through two hubs to a failed delivery the customer rescheduled, a second round and the
delivery, with a hub scan repeated. `in-transit.json` is between hubs. `not-found.json` is the
answer for a number GDEX has no record of.

Numbers, places and clocks are invented.
