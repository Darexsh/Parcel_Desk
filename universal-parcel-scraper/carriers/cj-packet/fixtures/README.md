# Fixtures

`delivered.json` and `in-transit.json` follow the tracker's reply for one number, newest scan
first, with the shipment fields the page reads. `delivered.json` goes from CJ's label to a USPS
delivery: the forwarder's and the courier's scans carry timestamps at China's and the
destination's offsets, CJ's own label line has none, one courier scan is repeated, the courier's
lines open with their place in brackets, the delivery names who signed, and the last-mile number
is a routing barcode with a ZIP code. `in-transit.json` waits at the destination's customs with
CTT Express named as the courier; the courier's notice comes after the forwarder's pickup
although its wall clock reads earlier. `not-found.json` is the answer for a number the tracker
does not know.

Numbers, names, shops, order references, places and clocks are invented.
