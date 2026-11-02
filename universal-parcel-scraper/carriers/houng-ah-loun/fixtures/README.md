# Fixtures

The fixtures follow the reply of `/v1/orders/tracking/{number}`: the bill's summary and its
scans, oldest first. Scan messages name the staff member who scanned the parcel and, at some
branches, a phone number, as the live replies do. `delivered.json` goes from one branch through a
sorting centre and a branch's warehouse to the destination branch, where the recipient collects
it. `in-transit.json` starts with a booking whose message is empty and stops at the sorting
centre. `returned.json` reaches the destination branch, goes back on a return request and is
collected at the branch it came from. `not-found.json` is the answer for a bill HAL does not
know, sent with HTTP 404.

Numbers, names, branches, staff, phone numbers, charges and clocks are invented.
