# Fixtures

`delivered.json`, `in-transit.json` and `registered.json` follow the shape of the app service's
ShortTrace reply: the AWB, a summary status, piece counts, who signed for the parcel, a sender's
reference and the scans, oldest first, each with an offset-less clock, a town and a county.
Numbers, names, references, places and clocks are invented. An unknown AWB gets an empty 204.
