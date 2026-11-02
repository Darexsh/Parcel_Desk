# Fixtures

The replies follow `Service.ashx`'s JSONP for one number, as the tracking page asks it.

- `delivered.txt` is a parcel Komon flew from China through Hong Kong to the United States,
  where the delivering network took it to a mailbox. Komon's scans state China's offset, the
  destination's airport's too; the delivering network's state none and open with their place
  and postcode. The merchant's order reference and a signatory are present so the tests can show
  they are left out.
- `not-found.txt` is the answer for a number the tracker does not know.

Numbers, clocks, places and the merchant's details are invented.
