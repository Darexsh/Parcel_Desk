# Fixtures

`collected.json`, `partner.json` and `returned.json` rebuild the public track endpoint's reply:
the barcode, the oldest-first scans with their operation code, English wording, offset clock,
place and comments, the partner mappings and the shipment's phase. Numbers, offices, places,
clocks, the masked recipient and the proof-of-delivery token are invented. `not-found.html` is
a trimmed copy of MySpeedy's "the requested resource does not exist" page, which the endpoint
answers with HTTP 404 for a number it does not know.
