# Fixtures

`delivered.json` and `inbound.json` follow the reply of `GET /api/v1/shipments/{number}` in
English: the shipment's summary, then its scans oldest first, each with its kind, wall clock
labelled `+00:00`, wording and location record. `delivered.json` is a domestic Póstbox parcel
handed in at a post office, held at the mail centre for a free locker under an Icelandic wording,
and collected; one notice is repeated. `inbound.json` is a parcel from abroad, with the sending
post's scans, held by the import department for its invoice, and an estimate. `invalid.json` is
the tracker's 400 reply for a code it calls invalid. An unknown code gets HTTP 204 with no body,
so it has no fixture.

Codes, places, clocks and log references are invented.
