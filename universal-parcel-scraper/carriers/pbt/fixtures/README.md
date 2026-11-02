# Fixtures

`delivered.html` and `in-transit.html` follow the page `www.pbt.nz/tracking-result/` renders for a
consignment it knows: each item headed by its number, the towns it was sent from and to and its
latest status, with its history oldest first, then the consignment's details and the page's
email form. `in-transit.html` is one item waiting in a driver's bay; its pickup request row
carries the request's reference and is stamped after the pickup, and one row is repeated.
`delivered.html` is a consignment of two items that share their history; its delivery rows name
the receiver and each heading links to a proof of delivery. No delivered reply of the current
tracker was seen, so those rows take the wording of the tracking service it replaced.
`not-found.html` is the home page's tracking form that the page's redirect for an unknown number
opens, with the number in the field.

Numbers, references, towns, sites, names, links, weights and clocks are invented.
