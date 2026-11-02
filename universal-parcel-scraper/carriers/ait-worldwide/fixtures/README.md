# Fixtures

Each file follows the page `fastrak.aitworldwide.com/?trackingnumber={number}` renders, trimmed
to its search form, its results and its contact form, with each shipment's history as data in
the history grid's settings, newest first.

`delivered.html` goes from the shipper's upload to the delivery, with a delivery appointment
between the out-for-delivery and delivery rows, one repeated row, the delivered panel naming its
signer and the meter at `Delivered`. `in-transit.html` is at the destination terminal, with the
panel inviting the recipient to book the delivery. `several.html` lists two shipments at
`Initiated` with their "Deliver By" days, as FasTrak lists those it finds by a reference; the
second is the number asked. `not-found.html` is the warning for a number FasTrak does not know.

Numbers, towns, signers, phone numbers, clocks and the form's token are invented.
