# Fixtures

The fixtures follow the reply of `/userSearchTrack` for one number, keyed by that number, with
the scans oldest first as the page receives them. `delivered.json` is a one-piece bill that YCS
picks up and hands to HCT Logistics, whose relayed sentences take it to the delivery; the
delivery is listed twice, and the rows carry the staff who entered them. `in-transit.json`
stays with YCS's own stations and waits at the delivering one, with the day YCS expects to
deliver. `pieces.json` is a bill of two pieces whose scans are listed by piece number, as the
page's script reads them. `not-found.json` is the answer for a number YCS does not know.

Numbers, names, stations, staff and clocks are invented.
