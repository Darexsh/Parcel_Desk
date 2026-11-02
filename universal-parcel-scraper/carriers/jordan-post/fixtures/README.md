# Fixtures

`inbound-delivered.html` and `outbound.html` follow the IPS page's item events in English, oldest
scan first. `inbound-delivered.html` is mail from the Netherlands, from the sending post's
despatch to the delivery: one arrival scan is repeated, customs records a retention reason and
hands the item back, a delivery office's location carries a postcode, a failed attempt gives a
reason and a measure, and the delivery names a signatory. `outbound.html` is mail posted in
Amman up to its bagging for abroad. `no-information.html` is the IPS page's answer for a code it
does not hold.

`search.html` is the tracking page's form as it opens. `search-empty.html` is its answer for a
code no record holds, with the code left in the field. `search-domestic.html` adds the results
grid of an item in Jordan Post's domestic records; no such item has been seen, so its table
follows ASP.NET's rendering of the columns the form's view state names after a search rather
than a captured page.

Numbers, names, places, clocks and form state are invented.
