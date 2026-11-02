# Fixtures

The replies follow `Service.ashx`'s JSONP for one number, as the tracking page asks it.

- `delivered.txt` is a parcel Yanwen carried to Australia and Australia Post delivered. The
  scans are in the tracker's order, by wall clock whatever the offset, one is listed twice, and
  the first carries the per-scan code a real reply had there. The merchant's order reference,
  the signatory and the proof-of-delivery link are present so the tests can show they are left
  out.
- `not-found.txt` is the answer for a number the tracker does not know.

Numbers, places, clocks and the merchant's details are invented.
