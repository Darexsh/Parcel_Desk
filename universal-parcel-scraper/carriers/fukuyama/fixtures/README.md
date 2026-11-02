# Fixtures

The pages follow `/corp/recieve/tracking_no_hunt/{number}` and are encoded in Shift_JIS, as the
tracker serves them. `delivered.html` has every milestone from the intake to the delivery, the
dispatch row with its day alone, the branch table and the links to the waybill images, with a
commented-out pair of links for another number. `in-transit.html` is for a ten-digit number,
which the page prints padded to eleven digits; only the intake and the dispatch rows have a day.
`not-found.html` is the answer for a number Fukuyama does not know, and `refused.html` is the
search form the tracker returns for a number it does not take, echoing that number.

Numbers, branches, addresses, phone numbers and clocks are invented.
