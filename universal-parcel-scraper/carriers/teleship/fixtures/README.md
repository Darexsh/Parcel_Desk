# Fixtures

The fixtures follow the reply of `api.teleship.com/api/tracking/{number}`, scans oldest first
as it lists them. `delivered.json` goes from the label to a delivery in the US: one hub scan is
repeated, two places carry a line-haul partner's name, the delivery names who signed for it,
and the reply carries a recipient and a USPS last-mile number. `in-transit.json` waits at import
clearance in Belgium and names bpost as its last-mile carrier; one scan carries a phone number
and a place that is only a partner's name. `cancelled.json` is a label the shipper voided.
`not-found.json` is the HTTP 404 answer for a number Teleship does not know.

Numbers, IDs, names, places, clocks and every event code but `S_102` and `S_902` are invented.
