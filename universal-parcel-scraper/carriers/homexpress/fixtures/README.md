# Fixtures

`trace-delivered.json` follows the reply of the lookup HOMEXPRESS's tracking page makes,
`/api/trace/orderRoute`, newest scan first, from order creation in a Sydney depot to delivery.
Each scan carries the suburb, state and postcode, and the delivery scans the coordinates and
proof photos, which the adapter leaves out; the out-for-delivery scan names the driver.
`trace-in-transit.json` is a parcel collected in a Perth warehouse, under another offset.
`trace-not-found.json` is the tracker's answer for a number it does not know.

Numbers, names, places, channel, photo links, coordinates and clocks are invented.
