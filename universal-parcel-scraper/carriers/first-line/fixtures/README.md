# Fixtures

`page.html` is a cut-down tracking page: the form's text area and the script that posts it to
the lookup address signed for the page's session.

The `.txt` files follow the lookup's reply: `ok{FGF}` and an HTML list with a header row, then
the scans newest first, each a wall clock, a place and the wording. `delivered.txt` is a parcel
flown from Shenzhen through Hong Kong to New York that USPS delivered: the order data without a
place, the Shenzhen warehouse's rows with a repeated one, the flight and customs rows, then
USPS's scans on the destination's clocks, ordered by wall clock among the others, some with a
postcode. `export.txt` is a parcel still at the Shenzhen warehouse after its export declaration.
`not-found.txt` is the answer for an unknown number and `refused.txt` the answer for a lookup
without the page's session.

Numbers, places, postcodes, signatures and clocks are invented.
