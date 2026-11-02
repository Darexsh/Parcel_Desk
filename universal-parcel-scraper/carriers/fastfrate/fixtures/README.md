# Fixtures

The fixtures follow the reply of `trackerapi/shipmentinformation/quicktrack` for one probill: the
probill as a number, the timeline oldest first, the shipper's references and the service message.
`delivered.json` runs from the shipper's electronic order to a delivery by appointment, with an
estimate row, a repeated terminal row, a row dated without a time, and the driver's arrival at and
departure from the consignee stamped after the delivery. `in-transit.json` is on its way to the
destination terminal, with the driver's arrival at the shipper stamped after the pickup and an
estimate row. `not-found.json` is the answer for a probill Fastfrate does not know: the probill
with an empty timeline.

Probills, references, places and clocks are invented.
