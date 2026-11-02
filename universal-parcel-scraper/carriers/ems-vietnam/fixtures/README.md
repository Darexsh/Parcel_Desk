# Fixtures

Each file follows the reply of `TrackAndTraceItemCode` in Vietnamese, oldest scan first, with the
item record and the delivery table. `delivered.json` is a cash-on-delivery item in the current
layout: a coded acceptance with the customer-service line, a slip, a repeated arrival scan, a
failed attempt, two rounds with their routing notes, the cash taken and handed in, and a
delivery table and summary that name the receiver. `in-transit.json` goes from the pickup
request to the destination office, with a sender reference. `legacy.json` is the older layout,
with offices in the position field, the postman's name and phone after the handover and office
phones. `international.json` leaves for abroad: its last scan names no Vietnamese office, and
its delivery table holds the international exchange's dated rows. `not-found.json` is the answer
for a number the tracker does not know.

Numbers, names, offices, addresses, phones, weights and clocks are invented.
