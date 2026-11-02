# Fixtures

`delivered.json`, `in-transit.json` and `not-found.json` follow the reply of the freight
system's trace, `RETR_MISS_CONS_DATA___TM`: the consignment with its addresses and parties,
then each item's events in no order. `delivered.json` is two items picked up, scanned through a
hub and delivered, each scan listed once per item, a few seconds apart. `in-transit.json` is
three items booked, picked up, loaded at a dock and waiting at the destination depot, with the
estimate set. `not-found.json` is the answer for a number the system does not hold.

`booking.json` and `booking-not-found.json` follow the reply of the bookings search,
`RETRI_CONSI_DATA___OEC`, for a consignment booked before the freight system has it and for a
number it does not hold.

Numbers, account codes, parties, addresses, places, postcodes, notes and clocks are invented.
