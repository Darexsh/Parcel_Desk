# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `GET /api/TrackTrace?trackTraceCode={number}`:
the item's scans newest first, each with its parcel's sequence number, scan code, Faroese wording,
zone-less wall clock and place. `delivered.json` is a parcel from abroad, with the sending post's
and the Danish hub's scans named by country, held by customs for its invoice and delivered.
`in-transit.json` is an item handed in at a Faroese office in summer, with one scan listed twice
and a scan without a place. An unknown number gets HTTP 204 with no body, so it has no
fixture.

Numbers, places, clocks and the delivery wording are invented.
