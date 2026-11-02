# Fixtures

Each file follows the page `domex.lk/Order-Details.php?wbno={number}` answers, cut down to the
start of the site's header, the search box that keeps the number asked, the waybill, sender,
delivery and receiver tables, the tracking table, and the start of the footer.

`returned.html` follows the replies seen: a parcel that waits at the delivering branch, goes
back through the hub and is returned to the sender, with one hub scan listed twice and the
head office closing the waybill last. `in-transit.html` is a waybill up to the hub.
`delivered.html` goes from the pickup to a delivery after a rescheduled round; no delivered
reply was seen, so its delivery line follows the others' form. `not-found.html` is the page's
answer for a number it has no record of.

Numbers, names, addresses, phone numbers, branches, towns, weights and clocks are invented.
