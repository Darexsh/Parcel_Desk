# Fixtures

`delivered.json`, `in-transit.json`, `inbound.json` and `not-found.json` follow the shape of the
tracker's `POST /api/v1/tracking` reply: one entry naming the code, its scans newest first, each
with its code, system, timestamp, wall clock, office, office index and wording, then the entry's
flags, a lookup id and a barcode image. `delivered.json` is a domestic item delivered at its
delivery office, `in-transit.json` one between offices and `inbound.json` mail from abroad with
the sending post's scans, customs and its arrival at the delivery office. `not-found.json` is the
reply for a code the tracker has no data on, and `invalid.json` its validation reply for a code
of the wrong format. Codes, offices, towns, indexes, clocks, ids and the image are invented.
