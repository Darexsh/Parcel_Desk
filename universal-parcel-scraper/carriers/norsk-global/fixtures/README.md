# Fixtures

The replies of Norsk's `POST /api/public/{token}/tracking`, with the fields its tracking page
reads. `delivered.json` is a parcel handed to USPS: its partner number is a routing barcode,
its scans are newest first with wall clocks and a copy of the clock at the start of each
message, one scan is repeated, and the reply carries the recipient's name and postcode and
the proof of delivery's signatory. `in-transit.json` is a parcel Landmark Global passes to
bpost, its scans oldest first with UTC offsets. `not-found.json` is the answer for a
reference Norsk does not know.

Numbers, names, postcodes, places and clocks are invented.
