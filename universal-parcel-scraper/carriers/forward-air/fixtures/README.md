# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `tracking/shipments`: the errors, then
each shipment's summary and its scans, newest first, with the fields the page reads and the ones
it does not. `delivered.json` holds three shipments: an older station-to-station one under the
same waybill, the newest one, collected from the shipper and delivered to the door across two
zones with one arrival listed twice, and one the tracker found by its customer's reference. Its
summaries carry a signer, a customer's account and reference, and its scans name who recorded
them. `in-transit.json` is a station-to-station shipment at its destination station: a booking
scan without a zone, a Mountain time arrival and a departure in the hour Central clocks repeat.
`not-found.json` is the answer for a waybill Forward Air does not know.

Numbers, names, accounts, references, manifests, clocks and routes are invented.
