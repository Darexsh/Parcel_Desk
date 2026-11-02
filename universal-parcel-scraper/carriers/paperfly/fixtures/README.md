# Fixtures

Each file follows the reply of `track_order.php`, with the sender, recipient and package blocks
the page reads and the history newest first. `delivered.json` is an order found by its Daraz
reference: it goes from the pickup request through a hold and two delivery runs, which name
their rider, to the delivery and the invoice, with one line repeated. `in-transit.json` is out
for delivery. `closed.json` is a delivered order whose history kept a single in-transit line.
`not-found.json` is the answer for a number no order has.

Numbers, names, places, phone numbers, amounts and clocks are invented.
