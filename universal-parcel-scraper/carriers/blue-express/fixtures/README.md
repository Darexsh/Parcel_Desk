# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's
`/api/tracking/microestado`: the scans newest first, one day group each, with their code,
title, internal place code and the town or point the page names. Scans without a title, which
the page leaves out, sit between them. `delivered.json` is a parcel dropped off at a Blue Express
point and delivered in another region. `in-transit.json` is a parcel out for delivery again
after a failed round and a new delivery address.

`not-found.json` is the lookup's answer, with HTTP 404, for a number it does not know.

Numbers, points, towns, addresses, place codes and clocks are invented.
