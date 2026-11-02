# Fixtures

`delivered.json`, `pickup.json` and `in-transit.json` follow the shape of the reply Chit Chats
gives at `/tracking/{shipment ID}.json`: the shipment's towns, postcodes, package, service,
estimate and partner carrier with its number, then its scans newest first. `delivered.json`
goes through USPS, with a routing barcode and a repeated scan; `pickup.json` through Canada
Post in winter time, waiting at a post office; `in-transit.json` has Chit Chats' own scans
alone, filed under no status as older shipments are.

`not-found.html` follows the search page an unknown shipment ID is redirected to, with the
notice its session carries.

Shipment IDs, partner numbers, towns, postcodes, addresses, tokens and clocks are invented.
