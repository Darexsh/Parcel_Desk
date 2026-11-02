# Fixtures

Each file follows the reply of Micro Express's `/partner/tracking-info` for one number: a code,
a message and the number as sent, with its scans newest first, each with an instant in
milliseconds, the same clock as text in the zone it names, the wording, the depot's suburb and
state, and an event code. `delivered.json` is a parcel sorted in one state and delivered from a
depot in another, with a sorting scan entered later that sits out of order in the reply.
`in-transit.json` is a parcel out for delivery in winter, with two scans in the same second.
`not-found.json` is the answer for a number Micro Express does not hold.

Numbers, suburbs and clocks are invented.
