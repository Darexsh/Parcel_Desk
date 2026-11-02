# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's
`/api/v3/Tracking`: the parcel's current milestone, then each milestone with the lines the page
lists under it, newest first, around the page's help texts, the sender's account and the
delivery round's details, which the adapter drops. `delivered.json` is a door delivery whose
lines name the branches and towns on the way. `in-transit.json` is a parcel out for delivery
whose history starts at intake; its last milestone is still to come, without lines or a clock,
as the page's script expects.

`not-found.json` is the service's answer for a number it does not know, sent with HTTP 206.

Numbers, branches, towns, accounts and clocks are invented.
