# Fixtures

The files follow the reply of `api.c3x.ae/api/Tracking`: an entry for the airwaybill asked, with
its origin, destination, forwarding number, shipper reference, weight and scans newest first,
beside the proof-of-delivery image slots the reply always carries.

- `delivered.json` is a parcel from Sharjah delivered in Abu Dhabi. Its details reached C3X
  after the parcel did, and its delivery scan names who took it.
- `in-transit.json` is a parcel for India at C3X's facility, with a forwarding number.
- `not-found.json` is the answer for an airwaybill C3X does not know: the number with every
  other field empty.

A refused request, a browser check and the other failures are built inline in the tests.

Numbers, references, names, places and clocks are invented.
