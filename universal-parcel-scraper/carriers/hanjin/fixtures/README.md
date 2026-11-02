# Fixtures

`delivered.html`, `in-transit.html` and `international.html` follow the shape of the page
Hanjin's tracker renders for one waybill: the search form in the header, with its script, the
number, a summary of the newest scan, the basic table, the progress rail and the scans, oldest
first, each followed by the collector's or courier's name and phone, a customs link or the call
centre's number. `delivered.html` is a domestic waybill on the current page, with an empty row.
`in-transit.html` is a domestic waybill flown in from abroad, on the older page with `th`
headings, still moving after customs. `international.html` is a delivered international waybill
with its master bill. `not-found.html` is the notice page the tracker serves for a number it
does not know; it names no number.

Waybills, master bills, names, phones, goods, towns, terminals, flights, dates and clocks are
invented.
