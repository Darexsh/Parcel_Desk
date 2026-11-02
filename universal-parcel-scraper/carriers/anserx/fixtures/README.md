# Fixtures

The files follow the reply of `getTrackInfo` on `oms.anserx.com`: a list of the shipments
found, each with its countries, the customer's account code and order reference, the delivery
number, and its scans newest first in English and Chinese with a place and a wall clock.

- `delivered.json` is a parcel from AnserX's sorting centre in China to its delivery in Mexico.
  Its delivery scans name the town with a postcode, and it has no delivery number.
- `in-transit.json` is a parcel for the United States, cleared and with the delivery carrier,
  whose delivery number is a USPS number.
- `not-found.json` is the answer for a number AnserX does not know.

A refused request, a browser check and the other failures are built inline in the tests.

Numbers, references, places and clocks are invented.
