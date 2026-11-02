# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/parcels/track-public/{number}`: a
list holding the parcel, with its summary and its scans, newest first. Scans carry a parcel
status, and some a BPX event code and wording. `delivered.json` goes from the label to the
delivery; one flight scan comes twice, and the warehouse scan's place has a postal code.
`in-transit.json` waits at destination customs. `not-found.json` is the HTTP 404 answer for a
number BPX does not know.

Numbers, ids, places and clocks are invented, and so is every scan's wording but `Label Created`.
`BPS-0002`, `BPS-0700` and `BPS-0800` are made-up codes.
