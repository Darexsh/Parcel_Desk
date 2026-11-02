# Fixtures

Replies of `/api-ship/tracking/{number}/scan`, in the order the tracker gives its scans, which
is not the order of their clocks. `delivered.json` is a summer parcel from its creation through
COLL-8's customs to the partner's delivery, handed to DPD with a nine-digit consignment number.
`in-transit.json` is a winter shipment of two packages at customs, whose creation and
sender-data scans come once per package, with two customs entries. `not-found.json` is the
answer for a number the tracker does not know.

Numbers, references and clocks are invented.
