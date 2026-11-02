# Fixtures

`search-in-transit.html` follows the English search page (`GET /en/?ShNumber=`) for a shipment
it holds, cut to its search form and summary: the requested number in the search field, the
summary list with its delivery location and the hidden list of items. `search-not-found.html`
is the same page answering a number it does not hold.

`history-in-transit.json` and `history-delivered.json` follow the history the page's "Details"
link loads (`GET /en/?ltlHistory=`), oldest first, with the history's own wording and padded
place names. The first repeats a row. The second has a delivery cancelled by a pseudo-scan, a
second round, a delivery confirmed by text message, a claim after it and remarks on the
delivery rows. `history-none.json` is the answer for a number without a history.

Numbers, terminal codes, dates, clocks, the delivery location and remarks are invented. The
scan places are large Polish cities.
