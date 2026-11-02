# Fixtures

The files follow the Portuguese page `GET /?reference={number}` on `tracking.dpd.pt` returns, cut down to its search form and its answer: the heading naming the
reference, the current status, the progress rail and the history table, newest scan first,
with its code, day, time, wording, comment and map link.

`delivered.html` is a parcel the sender dropped at a pickup point, delivered to the door after
a missed delivery. One van scan is listed twice, two messages to the recipient come before the
delivery, and the page names the receiver and links a proof of delivery. `at-pickup-point.html`
is a parcel left at a pickup point after the locker it was meant for was full; the point's scan
names it. `in-transit.html` is a parcel from abroad back at the depot after a failed attempt,
with an address change requested. `not-found.html` is the page's answer for a reference it
does not know.

Numbers, names, references, places, coordinates and clocks are invented.
