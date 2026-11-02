# Fixtures

The fixtures follow the reply of MotionTools' `GET /api/hailing/packages/{tracking_code}/tracking`,
which Fastdrop's tracking page reads: the package's status, its journey of pickup and drop-off
stops, the delivery estimate, the deliberately inexact pins and, while out for delivery, the
driver's position. `delivered.json` lists its stops newest first, as the platform documents,
with a failed delivery and a second round through the hub. `in-transit.json` lists them oldest
first, out for delivery with an estimate and the delivery stop not yet resolved, its clocks in
Malta's summer offset. `not-found.json` is the answer for a tracking ID Fastdrop does not know.

Numbers, shortcodes, coordinates, reasons and clocks are invented.
