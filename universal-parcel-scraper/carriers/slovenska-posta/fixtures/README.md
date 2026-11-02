# Fixtures

`collected.json`, `abroad.json`, `returned.json` and `retained.json` follow the shape of the
tracking page's JSON answer: one item with its state, weight, countries and events, newest first,
each with a code, English and Slovak wording, a wall clock sent as if it were UTC, and the branch
or the country. Branches carry the street, postcode, coordinates and phone numbers the service
sends. Numbers, branches, coordinates, phone numbers and clocks are invented. `not-found.json`
and `not-posted.json` are the answers for a number the service does not know and for one a sender
holds but has not posted. `blocked.html` follows the firewall's block page.
