# Fixtures

Each `.json` file is a reply of the tracking service, `api.php/shipment?code=`, which the
tracking page calls.

`delivered.json` is mail from abroad: the sending post's rows, all at one clock, its arrival at
the inward office of exchange, listed twice, then the post's own offices through to the
delivery, which also names the postman. The domestic rows come first, as the service sometimes
lists them. `in-transit.json` is an item posted in North Macedonia and bagged at the outward
office of exchange, with the old spelling of that note. `no-history.json` is the delivery record
the service gives for some items instead of scans, with the recipient's name and address.
`not-found.json` is the service's answer to a code it does not know. `rejected.html` is a
firewall's page in place of the service's.

Codes, offices, office codes, postcodes, names, addresses, dispatch numbers, days and clocks
are invented.
