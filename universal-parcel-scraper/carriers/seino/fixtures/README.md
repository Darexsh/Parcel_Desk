# Fixtures

`delivered.html`, `in-transit.html` and `not-found.html` are the tracking page after a lookup of
one number, trimmed to the result list and the shipment's detail. They are stored in UTF-8 with
the page's own Shift_JIS declaration; the tests encode them to Shift_JIS as the site serves them.

`delivered.html` was delivered on a second run (code 22). It is received at the end of September
and delivered in October, skips the relay milestone, and carries branch phone numbers, a driver's
phone, a vehicle and a destination area code. `in-transit.html` is at the delivering branch
(code 07); it is received at the end of December and arrives in January, and its relay milestone
names a branch without a time. `not-found.html` is the answer for a number Seino has no shipment
under.

Numbers, branches, codes, phone numbers and clocks are invented.
