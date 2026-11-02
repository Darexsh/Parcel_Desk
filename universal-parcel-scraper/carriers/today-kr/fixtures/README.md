# Fixtures

Each fixture is the tracking page's opened lookup: the page's type and the answer it seals into
`__NEXT_DATA__`. The tests seal it again and wrap it in a page. `delivered.json` is a parcel
carried between two addresses through three stations, with the names, phones, coordinates and
products the answer carries. `in-delivery.json` is an AliExpress-style parcel picked up at a
shipper's centre and on its way from its last station, looked up by the number the page shows.
`returning.json` is a return taken from an address and bound for the shipper, not yet
delivered. `not-found.json` and `expired.json` are the page's answers for an unknown number and
for a parcel delivered more than three months ago.

Numbers, names, phones, places, coordinates, products and clocks are invented.
