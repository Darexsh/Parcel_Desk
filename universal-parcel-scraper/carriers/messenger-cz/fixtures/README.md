# Fixtures

The fixtures follow the fields tracking.messenger.cz reads from its
`trackingStatus` lookup. No live found reply has been seen, so the clock
encodings are those the parser accepts: `delivered.json` dates its scans in
epoch milliseconds, newest first, and `in-transit.json` gives wall clocks
without an offset, oldest first.

`delivered.json` goes from the order to a door delivery: one depot scan is
repeated, and the scans and state carry the names of the people who handed
over and took the parcel. `in-transit.json` waits at an AlzaBox in Bratislava;
its depot scan falls in the hour the clocks repeat when they go back. An
unknown number gets HTTP 204 with no body, which needs no fixture.

Numbers, names, addresses, coordinates, phone numbers and clocks are invented.
