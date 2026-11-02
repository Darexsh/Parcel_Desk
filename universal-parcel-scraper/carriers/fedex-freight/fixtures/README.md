# Fixtures

Each file follows the shape of the reply `POST track/v2/track-shipments` gives: `output.packages`
with each shipment's summary, parties and scans, newest first, trimmed to the fields the adapter
reads and the personal ones it must leave behind. PRO numbers, towns, parties, references,
coordinates and clocks are invented.

- `in-transit.json`: a shipment at its delivering terminal, with an estimated day.
- `delivered.json`: a delivery with the driver's arrival, a weather exception on the way, one scan
  listed twice, and the receiver's and signee's names.
- `not-found.json`: a package the service flags as not found, as the page reads one.
- `empty.json`: the answer without any package, which the service also gives a value it refuses.
- `refused-request.json`: the gateway's HTTP 400 answer to a request it cannot read.
