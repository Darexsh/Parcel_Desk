# Fixtures

The files follow the reply of the `trackings` lookup on `ec-gateway.chukou1.com`, which the
EC-FirstClass tracking page makes: a list of the shipments asked, each with its status, its
countries and destination postcode, the destination carrier's number, Chukou1's own scans and
one feed per partner carrier, all newest first with a wall clock, and a proof of delivery.

- `delivered.json` is a parcel Chukou1 flew to the United States and handed to USPS, which
  delivered it. USPS's scans name towns with ZIP codes, and the proof of delivery is a stub.
- `in-transit.json` is a parcel Chukou1 handed to China Post in China, whose scans come in two
  feeds that repeat each other with their places written differently.
- `not-found.json` is the answer for a number Chukou1 does not know.

A refused signature, a browser check and the other failures are built inline in the tests.

Numbers, places, postcodes, clocks and the proof of delivery are invented.
