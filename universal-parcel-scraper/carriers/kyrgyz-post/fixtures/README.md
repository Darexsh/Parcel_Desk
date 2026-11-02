# Fixtures

The replies of the tracking page's `get_track_number` lookup, oldest scan first, as the tracker
sends them.

`delivered.json` is an item from abroad: the sending post's office of exchange receives and bags
it, with the office after each event, then Kyrgyz Post's international exchange, a sorting office
and a post office take it in until it is handed over. One scan is listed twice, and some wordings
keep the doubled and trailing spaces of the reply. `in-transit.json` is an item from abroad that
has reached the post office that delivers it. `outbound.json` is an item posted in Kyrgyzstan,
taken in at an office named with its postcode and sent abroad. `not-found.json` is the reply for a
code the tracker does not hold.

Numbers, offices, postcodes and clocks are invented.
