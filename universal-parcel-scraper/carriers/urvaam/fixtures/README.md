# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `track/batch` for one number, newest
scan first, with the status counters the page shows above the history and every field the
tracker sends for each scan. `delivered.json` goes from the sender's record to a delivery into
the letterbox, through Barcelona's platform and a delivery depot. One sort scan is repeated, the
delivery scan carries a signature link and the round scan a driver id. `in-transit.json` has a
failed round, a claim, and a second receipt at the depot on the same second as the claim.
`not-found.json` is the answer for a number Urvaam does not know.

Numbers, references, depots, ids, links and clocks are invented.
