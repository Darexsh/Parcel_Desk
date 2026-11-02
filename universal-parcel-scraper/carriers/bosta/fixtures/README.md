# Fixtures

`delivered.json`, `in-transit.json` and `returned.json` follow the reply of
`/shipments/track/{number}?lang=en` that Bosta's tracking page receives, oldest scan first, with
the fields the page reads. `delivered.json` is an Egyptian shipment from its creation and the
merchant's pickup request to the delivery; one warehouse scan is repeated and the out-for-delivery
scan carries the delivery window. `in-transit.json` is a Saudi shipment back at the warehouse after
the courier could not reach the customer. `returned.json` is an order the customer refused, which
turned into a return to the merchant: its warehouse, hub and courier scans on the way back are
worded for the return. `not-found.json` is the answer for a number Bosta does not know, and
`draft.json` the answer for a draft order the merchant has not confirmed.

Numbers, merchant ids and clocks are invented.
