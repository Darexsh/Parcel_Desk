# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `api/l3v14than-res1`, with the
`cnote` summary, the `detail` block and the `history` the app reads, scans oldest first.
`delivered.json` is a JNE Trucking consignment that goes from counter receipt to the door:
one warehouse scan is repeated, the delivery scan's bracket carries a recipient and the
summary carries a recipient, a shipper and a proof of delivery. `in-transit.json` is a
fifteen-digit resi still moving between hubs, taken in at a JNE counter. `not-found.json` is
the answer for a number JNE does not know.

Numbers, names, places and clocks are invented.
