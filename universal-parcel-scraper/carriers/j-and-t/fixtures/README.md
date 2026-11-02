# J&T Express fixtures

- `delivered.json`: an `order.massOrderTrack` reply from the Indonesian app router for one delivered waybill, newest scan first: drop-off, pick-up, a transit arrival, a departure, an arrival at the delivery drop point, a hold, out for delivery and delivered. It carries the courier, recipient, phone, remark, coordinate and picture fields the adapter must not project.

The router sends `data` as a JSON document inside a string; the fixture keeps it decoded for readability, and the tests encode it again. Every waybill, name, town, province, phone number, coordinate, link and time is synthetic.
