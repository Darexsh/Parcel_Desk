# Fixtures

Each file follows the shape of the reply `GET /tracking/tracking-request?ids={number}` gives for
one number: an array with one entry naming the number, `found` with the current status and the
scans newest first, or `not-found`. Numbers, ids, references, places, postcodes and clocks are
invented.

- `delivered.json`: an OSM package id from the label through two OSM facilities and the last
  mile partner to the delivery, with one scan repeated.
- `usps-transit.json`: a USPS barcode handed to the partner, with the tracker's milestone groups
  and an expected day.
- `attempted.json`: a failed delivery the recipient can give instructions for, with codes the map
  does not know and the label scan in the wording of OSM's FAQ.
- `not-found.json`: the answer to a number the service does not know.
