# Fixtures

`delivered.json`, `in-transit.json` and `not-found.json` follow the reply of `/api/track/{number}`:
the number, the sender's reference and the scans grouped under their day's heading, oldest first.

`delivered.json` goes from the collection at the sender's premises through a road leg, a failed
attempt with its text and e-mail records, a staff call note with RAM's # masks and a call carrying
a typed address, to the delivery with the receiver's name and the proof of delivery filed after it.
`in-transit.json` is a short reference on its second road leg; its loading line comes three times
in a row, once per parcel. `not-found.json` is the answer for a number RAM does not know, stamped
with the lookup's own clock.

Numbers, references, names, notes, places and clocks are invented.
