# Fixtures

The replies follow `Service.ashx`'s JSONP for one number, as the tracking page asks it.

- `in-transit.txt` is a parcel Intel-Valley flew from Shenzhen through Hong Kong, in the wording
  a universal provider relays from its tracker. Every scan states China's offset, the
  destination's too. One scan is listed twice so the tests can show it is kept once, and a
  booked flight so they can show it is left out. The
  merchant's order reference is present so the tests can show it is left out.
- `not-found.txt` is the answer for a number the tracker does not know.

Numbers, clocks, places and the merchant's details are invented.
