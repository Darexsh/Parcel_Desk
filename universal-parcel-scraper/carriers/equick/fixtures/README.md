# Fixtures

Each file is a reply of Equick's `POST /api/traceQuery` for one number: `code`, `msg` and
`data`, which keys the number asked to its scans. Each scan has its own id, a Status column
label, the shipment's number, a wall clock, a place, its wording, the destination country and
the delivering carrier's number, empty until there is one.

`transit.json` is a parcel on its way to the Netherlands, with a pick-up scan labelled `Hold`
and the destination carrier's relayed notice that it has the data but not the parcel.
`delivered.json` is a delivery in Germany through a last-mile carrier whose number the later
scans carry, with a repeated scan, a signer and a phone number. `not-found.json` is the reply
for a number the tracker does not know, and `failed.json` the reply of a lookup the service
did not complete.

Numbers, ids, places and clocks are invented.
