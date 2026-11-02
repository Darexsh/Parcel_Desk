# Fixtures

`page.html` is a cut-down tracking page: the site's search form and the tracking form, whose
hidden `__RequestVerificationToken` the lookup sends back, and the script that posts the number.

The JSON files follow the shape of the page's `POST /Cliente/SegumientoLinea/ObtenerTracking`
reply: an array of scans newest first, each with `fecha` (month first), `evento`, `codigo` and
`observacion`, the page's note under the scan or a map link to the office. The reply does not
name the item code.

`delivered.json` is a domestic item delivered after its office received it, with the office's
address, WhatsApp number and map, and a repeated row. `in-transit.json` is an item being sorted
for delivery. `not-found.json` is the reply for a code the tracker does not know.

Item codes, offices, addresses, phone numbers, coordinates, tokens and dates are invented.
