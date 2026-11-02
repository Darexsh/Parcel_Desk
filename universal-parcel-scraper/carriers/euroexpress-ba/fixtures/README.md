# Fixtures

Each file follows the reply of `app-api.euroexpress.ba/api/v1/pub/track` for one code: the
shipment's summary and its scans, or the error for a code the tracker does not know (HTTP 404).
The scans have the fields the tracking page and EuroExpress's app read from each row: `datum`,
`centar` and `opis`.

`delivered.json` is a delivered shipment whose scans carry offsets, newest first.
`in-transit.json` is a shipment out for delivery whose scans are wall clocks, oldest first, with
a repeated scan.
`summary-only.json` is a delivered shipment the tracker keeps without its scans.
`not-found.json` is the answer to a code the tracker does not know, with a shortened error.

Codes, names, places, contents, weights and clocks are invented.
