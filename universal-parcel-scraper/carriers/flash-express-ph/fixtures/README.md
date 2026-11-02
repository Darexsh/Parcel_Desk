# Fixtures

Each fixture follows the reply of the app's `parcels/track_parcel_batch` for one number, newest
scan first, with the fields it sends for the parcel and each scan. `delivered.json` uses the
older wording: its signature scan names the recipient, its call scan lists masked phone
numbers, its courier scans carry the courier's name and phones and one is repeated, and a van
scan is worded with a dash. `returned.json` fails delivery, goes back to its sender on the same
number and ends with the sender taking it; its first row came without a code. `in-transit.json`
uses the newer wording with both van scans. `not-found.json` is the answer for a number the
tracker does not know.

Numbers, names, phone numbers, sites, places and clocks are invented.
