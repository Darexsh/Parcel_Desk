# Fixtures

The files follow the shape of the two replies 4-72's tracking page asks for one guía.

`search.html` is `Traceability/Search`: hidden inputs, the heading `Número de Guía` with the guía,
the shipment's card (sending date, service, quantity, weight, postage, service order), the sender's
and the recipient's cards, and the card above the scans with the linked guías and the receiver. The
tests swap its guía and service for the other histories.

The `events-*.html` files are `Traceability/Events`: a table of the scan's clock, the operating
centre, the event and a remark, oldest first. `events-delivered.html` is a certified letter
delivered after a visit that did not deliver, listed twice, with the receiver in the delivery's
remark, the signed document scanned and then carried back to the sender. `events-returned.html` is
an express item sent back after the recipient was not found there. `events-inbound.html` is mail
from abroad, released by customs and kept after a visit for an unpaid import duty, on 24-hour
clocks. `events-empty.html` is the table without rows, as for a guía the search does not know.

Guías, people, places, phone numbers and dates are invented.
