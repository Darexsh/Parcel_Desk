# Fixtures

`delivered.json`, `in-transit.json` and `redispatched.json` follow the reply of
`/mfe-rastreio/api/order-data` in Portuguese: the shipment's summary, then its scans under the
tracker's four milestones, each milestone's scans newest first. `delivered.json` goes from a
collection with a discrepancy, logged at the same second as the arrival and the wait to be
measured, through transshipments to the delivery; one delivery-round scan is repeated, and the
base's arrival and the delivery round share a second across two milestones. `in-transit.json`
waits on a delivery round. `redispatched.json` is an Amazon parcel handed to Correios, with the
Correios number in the summary and in a scan's wording.

`search-empty.json` is the answer of the search `/mfe-rastreio/api/basic` for an AWB the tracker
does not know, and `search-found.json` its answer for `delivered.json`'s AWB.
`access-denied.html` is Akamai's refusal of an address, and `too-many.html` the site's page for
too many requests.

Numbers, merchants, orders, invoices, base codes, ids and clocks are invented.
