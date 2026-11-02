# Fixtures

`delivered.json`, `abroad.json` and `cancelled.json` rebuild the public track endpoint's reply:
the barcode, the oldest-first scans with their operation code, English wording, offset clock,
place and comments, the partner mappings and the shipment's phase. `cancelled.json` keeps the
shape of a live reply. Waybills, places, clocks, the masked recipient, the proof-of-delivery
token and the partner network with its number are invented. `not-found.html` is a trimmed copy
of MyDPD's "the specified options were not found" page, which the endpoint answers with HTTP
404 for a waybill it does not know.
