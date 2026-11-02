# Fixtures

Each file is a reply of `GET /public/awb/{number}`. `delivered.json` is a booking the page
marks delivered, older-style scans that give a sentence in place of their first centre, newest
first, one scan repeated, a first scan whose UTC instant falls on the booking day only in
India, and two delivery run sheets that both read Delivered. `in-transit.json` is a booking
with newer-style scans that name both centres, clocks to the millisecond and no run sheet;
its empty booking status is invented, as no live in-transit reply was seen. `not-found.json`
is the answer for a number the service does not know: a booking that only echoes the number.
The last centre's details in each carry its manager's name and phones, which the page shows
and the adapter drops.

Numbers, names, phones, places and clocks are invented.
