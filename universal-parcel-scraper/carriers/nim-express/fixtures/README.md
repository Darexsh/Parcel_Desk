# Fixtures

Each file follows the page `www.nimexpress.com/web/p/tracking?h_i={number}` answers, cut down to
its header search box, its tracking form with the client address it echoes, the card and the
hidden bill details table, and a part of the script behind its phone-gated map dialog.

`delivered.html` is a card whose timeline goes, newest first, from the delivery back to the
sender creating the bill, through a booked pickup, the origin branch, a sorting centre and the
destination branch. `in-transit.html` is a card for a bill created at a drop point, up to a
sorting centre; no in-transit reply was seen, so it follows the delivered page with fewer
entries. `not-found.html` is the card's answer for a number it has no parcel for.

Numbers, branches, branch codes, places, clocks and the client address are invented.
