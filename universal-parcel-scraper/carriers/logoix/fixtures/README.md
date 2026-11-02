# Fixtures

Pages of `https://www.logoix.com/cgi-bin/tnt.pl?q=`, in the shape the tracker serves, trimmed
of its menus. `dhl.html` is a counter shipment (`Schalterversand`) handed to DHL, with the
partner's number and the script that loads the partner's history. `austrian-post.html` is a
forwarded parcel (`Nachsendung`) handed to Austrian Post across the October clock change.
`registered.html` is a booked parcel the sender has not handed in, its scan in the hour Berlin's
clocks repeat. Each history page carries the hidden row the tracker adds with the time of the
lookup. `not-found.html` is the notice for an unknown number and `expired.html` the one for a
number whose history the tracker no longer has. `rate-limited.html` is the pause the tracker
asks for between lookups, served with HTTP 429.

Numbers, partner numbers, clocks and the request check are invented.
