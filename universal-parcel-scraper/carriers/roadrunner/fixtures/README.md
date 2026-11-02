# Fixtures

`delivered.html` and `in-transit.html` follow the fragment
`tools.rrts.com/LTLTrack/TrackingShipment/ShipmentDataTab/{PRO}` returns for a shipment: the
shipment status, the subscription forms, the map's coordinates, the timeline, the shipper and
consignee with their addresses, the shipment overview, the travel history oldest first, the
services and the documents.

`delivered.html` is a residential delivery with special handling, a call to book the delivery
appointment and a trailer closed after the delivery run left. `in-transit.html` is a shipment
the page still calls picked up while its rows have moved on, ending with an unstaged row; it
adds a ship date and a due date to the shape of a picked-up shipment. `not-found.html` is the
alert the fragment gives for a PRO the portal does not have.

PRO, pickup and bill of lading numbers, names, addresses, coordinates, terminals, places,
clocks, weights, contact details and form tokens are invented.
