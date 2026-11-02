# Fixtures

`lookup.json` follows the reply of `/service/envios/detalle-envio-login-guid/{code}/{postcode}`:
a shipment record whose only filled field that matters is its `guid`. For a code and postcode the
tracker does not pair, the reply is an empty body, which the tests build inline.

`delivered.json` and `in-transit.json` follow the reply of `/service/envios/detalle-envio/{guid}`
with the fields the tracking page reads and the ones it carries beside them.

`delivered.json` goes from the documentation to the delivery. A failed attempt is an incident set
with two identical Pendiente de realizar rows at its clock, `ultEstado` repeats the newest row,
the delivery row carries coordinates, the expected date is hidden, and the record carries a
sender, a recipient, a town, an order reference, a remark with a phone and a link.
`in-transit.json` is out for delivery with the expected date shown and a weight; two of its rows
name the town of the scan, one row is repeated and one code is a number.

Numbers, identifiers, names, places, references, phones, links, coordinates and clocks are
invented.
