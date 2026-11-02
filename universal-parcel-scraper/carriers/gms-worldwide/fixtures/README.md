# Fixtures

Replies of the tracking page's lookup, `GET /webapi/get-consignment.php?cnno={number}` on
`www.gmsglobe.com`.

`delivered.json` has every field of a found reply, the number in `@attributes` and the summary
among them, then the scans newest first. Its history goes from the booking at a branch office through a hub to the
delivering office, with a failed attempt, and lists the last out-for-delivery scan before the
delivery on the same clock.

`in-transit.json` has empty fields as `{}`, as the reply gives them, no `Status`, and a summary
of "In Transit" over scans that stop at a hub.

`not-found.json` is the reply for a number GMS does not know.

Numbers, towns, offices, people, addresses, phones, references, links and clocks are invented.
