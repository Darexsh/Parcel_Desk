# Fixtures

Each file follows the shape of the reply `GET /delivery/{code}` gives on Jitsu's recipient
service: the tracker's settings, the route stops, the merchant, the shipment with its delivery
window and clock, its events newest first, the driver, the access codes, the postcode block and
the days off. Codes, clocks, merchants, towns, contact details, remarks, postcodes and positions
are invented.

- `delivered.json`: the label, the facility's receipt with a first scan that repeats it, the
  round, an address change and the delivery, with a row that has no clock.
- `redelivery.json`: a failed attempt, the parcel back at Jitsu and planned again, then a late
  round whose window moves past a day off.
- `linehaul.json`: the label and a partner carrier's scans before the parcel reaches Jitsu, with
  the window the shipper hides.
