# Fixtures

`delivered.json`, `in-transit.json` and `not-found.json` follow the shape of the `get_session_data`
reply of a myRaben session opened by the tracking deep link: the instruction opening a page, the
session's objects with empty attributes, the changes that give them their values, and the
enumerations with their English captions. `delivered.json` is a shipment collected in Germany and
delivered in Austria, with a remark, a notice and two rows at the same instant. `in-transit.json` is
one in a warehouse in Lithuania after leaving Poland. `not-found.json` is the page saying a number
could not be found. The status captions are the page's own list; numbers, ids, towns, depots,
phone numbers, remarks, weights and clocks are invented, and the reply's other session fields are
left out.
