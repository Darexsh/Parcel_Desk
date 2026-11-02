# Fixtures

The fixtures follow the reply of `/order/track` for one waybill, scans oldest first.
`delivered.json` goes from TopYou's first-mile warehouse through the flight and customs to USPS's
delivery: TopYou's scans carry `+08:00` and name the destination country, one with the origin
airport, its customs scan leaves its country empty, a USPS acceptance is repeated and the USPS
scans have no offset. `in-transit.json` waits at destination customs with no transfer number.
`relayed-europe.json` hands a parcel to GOFO in France, whose scans TopYou relays at `+01:00` on UTC
wall clocks. `post-line.json` follows a line whose last mile a post delivers, in that line's
wording, its warehouse's outbound scan naming the post's number. `announced.json` is an order with a destination and no scans, and `not-found.json` the answer for
a number TopYou does not know.

Numbers, clocks, places and weights are invented.
