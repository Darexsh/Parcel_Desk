# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/saastms/mobileWeb/track/query` in
English, newest scan first. `delivered.json` goes from the order to the delivery through a
booked flight, clearance, two delivery runs and a driver's reason: one run is repeated, the
run scans carry the driver's phone, and the delivery names who took the parcel and links its
proof photos. `in-transit.json` waits at destination customs after a pickup and a flight, and
names a last-mile number. `not-found.json` is the answer for a number iMile does not know.
`cainiao-delivered.json` is Cainiao's `detail.json` reply for the delivered parcel, naming iMile
as its carrier: the China leg, a flight handover with a day and no clock, iMile's order on a
clock without a zone, and its relays of iMile's scans.

Numbers, names, phones, places and clocks are invented.
