# Fixtures

The fixtures follow the record GO4's tracking page reads from its
`status.php` lookup: the fields of the sample record bundled in the
tracker's script and the fields its template shows.

`delivered.json` goes from the order to a delivery after one failed attempt,
whose reason carries a phone number; the record names the person who took
the parcel and the client's note. Its shipment number is a JSON number, as in
the bundled sample. `in-transit.json` gives the number as a string, was
collected in the hour the clocks repeat when they go back, and holds the zero
date a database writes for a delivery it does not have. `not-found.json` is
the empty record the lookup returns for a number it does not know.

Numbers, names, notes, phone numbers and clocks are invented.
