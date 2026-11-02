# Fixtures

`delivered.json` and `in-transit.json` follow the English reply of `tracking.php`, scans newest
first, each with the wall clock and the instant the tracker makes of it on Kyiv time.
`delivered.json` comes from the United States to Ukraine through Poland: Nova Poshta is the
partner, and the parcel goes from a parcel locker to the recipient. `in-transit.json` goes from
Ukraine through Poland and Germany to the United States on its way to Canada, with UPS as the
partner, in winter; one Polish scan is repeated. An unknown number gets an empty body, which the
tests build inline.

Numbers and clocks are invented.
