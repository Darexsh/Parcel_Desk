# Fixtures

The replies follow `Service.ashx`'s JSONP for one number, as the tracking page asks it.

- `in-transit.txt` is a parcel YYpost flew from Shenzhen through Hong Kong to Amsterdam and
  cleared there, bound for Portugal, with the onward network's number in `channel_hawbcode`.
  One scan is listed twice so the tests can show it is kept once. The merchant's order
  reference is present so the tests can show it is left out.
- `not-found.txt` is the answer for a number the tracker does not know.

Numbers, clocks and the merchant's details are invented.
