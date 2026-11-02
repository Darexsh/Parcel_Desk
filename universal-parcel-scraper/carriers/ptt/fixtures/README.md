# Fixtures

`delivered.json`, `collected.json`, `returned.json` and `abroad.json` follow the shape of the
reply of PTT's shipment query: the barcode, masked sender and recipient names, the weight in
grams and the movements, each with its date, time, office and Turkish wording. Barcodes,
offices, names and clocks are invented. `not-found.json` is the reply for a barcode without
movements and `invalid.json` the reply for one PTT rejects.
