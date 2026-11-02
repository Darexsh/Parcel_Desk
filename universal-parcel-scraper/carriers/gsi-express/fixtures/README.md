# Fixtures

`cleared.html` and `departed.html` follow the tracker's page for one receipt number, with its
long script cut down to the functions the page calls: the receipt number, the master air
waybill, the Korea Post waybill, the merchant's order number, the masked recipient, the time
the parcel left the US warehouse in Korean and US Eastern time, the empty flight table, the
customs clearance date and the domestic section with its empty table. `cleared.html` has
cleared Korean customs. `departed.html` has left the warehouse, has no clearance date or order
number yet, and opens with the PHP warnings the server prints before some pages.
`not-found.html` is the tracker's answer to a receipt number it has no record of.

Numbers, names, addresses and clocks are invented.
