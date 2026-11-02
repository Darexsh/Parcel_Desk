# Fixtures

Each JSON fixture holds the tracking page's two replies for one number, under the names of the
routes that give them: `parcel-tracking-data` with the scans, oldest first, and
`parcel-status-data` with the parcel's customs and delivery status.

`delivered.json` is a summer parcel GAASH delivers itself to a pickup point, where it is
collected. Its scans carry `GMT+03:00`, one is repeated, one has no time, and the later ones
carry a pickup point code and a collection code. `in-transit.json` is a winter parcel held for
transport ministry checks and fees, then cleared and handed to a delivery company GAASH names.
Its scans carry `GMT+02:00`, and its status holds a payment link. `not-found.json` is the answer
for a number GAASH does not know. `page.html` is the tracking page's shell, with the settings
script that gives the nonce.

Numbers, names, places, codes, links, nonces and clocks are invented.
