# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/tracking?number=`: the waybill's
summary, with the kind of shipment, the contract, the weight as text and the towns, then its
events oldest first, each dated to the day and worded as the event with the state and labelled
clauses in brackets. `delivered.json` runs from the collection to a delivery attempt that
delivered, naming who took the parcel, with a repeated departure, a town in a scan's clause, an
attempt that did not deliver and the delivery day and recipient in the summary.
`in-transit.json` stops at the destination's sorting centre after a delay at the airport, its
weight written with a comma. `not-found.json` is the answer for a waybill 4Sides does not know.

Waybills, contracts, people, towns and dates are invented.
