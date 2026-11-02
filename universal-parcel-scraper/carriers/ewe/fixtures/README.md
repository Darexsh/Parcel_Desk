# Fixtures

`trace-delivered.json` follows the trace tracker's `/api/trace/orderRoute` reply for an
Amazon-channel parcel, newest scan first, from order creation in a Brisbane depot to delivery.
Each scan carries the suburb, state and postcode, and the delivery scans the coordinates and
proof photos, which the adapter leaves out; the out-for-delivery scan names the driver.
`trace-in-transit.json` is a parcel collected in a Melbourne warehouse, under another offset.
`trace-not-found.json` is the trace tracker's answer for a number it does not know.

`lookup-delivered.json` follows the reply of the lookup the tracking page on www.ewe.com.au
makes, for an eMetro consignment of two articles, newest scan first, with the sender's and the
recipient's suburbs. `lookup-relayed.json` is the same lookup's reply for the parcel of
`trace-delivered.json`, with the scans it relays from EWE's delivery system, oldest first,
without places and with the driver's name. `lookup-not-found.json` is its answer for a number
it does not know.

Numbers, names, places, photo links, coordinates and clocks are invented.
