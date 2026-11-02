# Fixtures

Each file is the `OlvaTracking` object the tracking page's script holds for one `?q=` lookup;
the tests write it into the page as WordPress does, on one line with its non-ASCII characters
escaped. `delivered.json` is one of Olva's own numbers, read year first: the shipment, with the
recipient's name, district, masked phone and ID, and its scans in three milestones. A warehouse
scan keeps only its day, one delivery run is listed in two milestones, a failed attempt comes
before the delivery, and the last milestone lists its scans out of order. `in-transit.json` is
an AliExpress guide on its way, with no scan yet in its last milestone. `not-found.json` is the
page's answer for a number the tracker has no shipment for.

Numbers, names, places, weights and clocks are invented.
