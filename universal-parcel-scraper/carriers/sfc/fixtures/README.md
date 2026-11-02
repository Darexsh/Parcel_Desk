# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's `get-track-for-web`
lookup, newest scan first. `delivered.json` answers an AliExpress number: an order to Mexico
from the shop's label data to J&T Express's delivery, with a repeated scan, the expected flight
departure, the hand-over scan with the courier's phone numbers, the courier's own text after the
delivery and out-for-delivery scans, the shop's reference and a proof of delivery.
`in-transit.json` answers an SFC number for an order at destination customs, handed to a courier
the catalog does not know. `not-found.json` is the answer for a number SFC does not know.

Numbers, names, references, places, phone numbers, links and clocks are invented.
