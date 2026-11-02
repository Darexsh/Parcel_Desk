# Fixtures

`in-transit.json` follows the reply of `POST /api/trackinfo/` for one parcel to Poland: the
order's electronic information, then the warehouse in China booking it in and packing it for the
line abroad, newest first, each scan naming the last-mile number. The tests build the replies for
an unknown number and an order with no scans inline.

Numbers and clocks are invented.
