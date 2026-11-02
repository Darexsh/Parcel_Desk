# Fixtures

`delivered.html`, `in-transit.html` and `russian-post.html` follow the tracker's English page for
one number: the number over the destination and delivery type, the current status, the notice
that names the local carrier, the scans oldest first in a table and the batch.
`delivered.html` is a Qwintry Air parcel through its consolidation hub, JFK, customs and the
local carrier to the door, and links CDEK's tracker for the local carrier's number.
`in-transit.html` is an older parcel with the courier service's delivery estimates before its
scans and a repeated scan; it names DPD and its number. `russian-post.html` is a parcel Qwintry
handed to Russian Post, whose scans carry the post's operations and offices, and links Russian
Post's tracker. `not-found.html` is the tracker's HTTP 404 page for a number it has no record of.

Numbers, places, batches and clocks are invented.
