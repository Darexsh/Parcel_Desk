# Fixtures

The `search-*.html` files follow the quick search's HTML answer, a header row with the term and
the count, then a row per shipment. `search-delivered.html` and `search-in-transit.html` find one
shipment each, with its id, number and sender references; `search-not-found.html` is the answer
when nothing matches.

The `details-*.html` files are shipment pages cut down to the markup around the two script
values the parser reads. `details-delivered.html` is a former IPEC road shipment, oldest scan
first, from the consignment file to the delivery: it has a chute sort, a depot scan repeated with
a Sydney-clock twin among its items, an attempt nobody signed for, two days held for collection,
a signer and sender references. `details-in-transit.html` is a former Priority shipment between
depots, with states after some suburbs and an estimate. `details-missing.html` is the page
MyTeamGE serves for an id it does not know.

The `nz-*.html` files follow New Zealand's Fast Tracker. `nz-search.html` lists a consignment's
two items; `nz-search-not-found.html` is the notice for a number it does not hold.
`nz-item-delivered.html` is the first item's page from the booking to the delivery, with its
estimate, references and the receiver who signed; `nz-item-out-for-delivery.html` is the second
item's, still out for delivery.

Numbers, ids, names, references, places and clocks are invented.
