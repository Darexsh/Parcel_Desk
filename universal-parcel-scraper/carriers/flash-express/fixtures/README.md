# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/webApi/tools/tracking` for one
number, newest scan first, with the fields the tracker sends for the parcel and each scan.
`delivered.json` is picked up by a Flash Home agent, kept at the delivery branch, closed and
reopened, then delivered. Its signature scan names the recipient, its call scan lists masked
phone numbers, its courier scans carry the courier's name and phones, its summary carries the
signer and proof-of-delivery photos, and one scan is repeated. `in-transit.json` uses the
newer wording, whose scans carry no state, and ends with a failed delivery, the parcel back at
its branch and a reminder. `not-found.json` is the answer for a number Flash Express does not
know.

Numbers, names, phone numbers, sites, places, links and clocks are invented.
