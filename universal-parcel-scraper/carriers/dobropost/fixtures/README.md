# Fixtures

`delivered.json`, `in-transit.json` and `russian-post.json` follow the reply of
`/api/tracking/parcel`: the countries and the checkpoints, newest first, each with its clock
at Moscow's offset, its code, its Russian wording and the tracker's category. `delivered.json`
goes from the China warehouse through customs to a CDEK delivery, with towns in brackets, a
repeated scan, a code with a trailing tab and the start of clearance listed out of turn.
`in-transit.json` has reached destination customs on its way to Belarus. `russian-post.json`
ends with Russian Post's last leg, whose scans carry no code: a return, a forwarding and the
delivery. `not-found.json` is the answer for a number DobroPost does not know, and
`key-refused.json` the answer to a key it does not accept, with its stack trace shortened.

Numbers, towns and clocks are invented.
