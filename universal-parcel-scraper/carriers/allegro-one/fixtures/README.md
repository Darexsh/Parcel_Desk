# Fixtures

`delivered.json`, `ready.json` and `returned.json` follow the shape of the edge service's reply:
`status`, a list of scans newest first, each with a UTC instant and an English wording.
`in-transit.json` lists its scans oldest first, as the service does for newer parcels. The clocks
and sequences are invented; `delivered.json` repeats one scan so the tests can check that identical
rows are dropped. An unknown number's reply is `{"status":[]}`.

`delivery.json` and `sent-back.json` are Allegro Delivery parcels, listed oldest first: one
collected from a locker after a notice at the door, one sent back after the courier found its
point unavailable, with the scans of its way back. Their clocks and sequences are invented too.
