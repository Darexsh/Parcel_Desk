# Fixtures

`not-found.json` is the reply of `getDetailByWaybillNo` for a waybill J&T Express Middle East
does not know. `delivered.json` and `in-transit.json` have the shape of a found waybill's reply:
one answer in `data` that names the waybill in `keyword` and lists its scans in `details`,
newest first, each with every field a live scan has. Only the order creation scan copies a
live one's label, code and sentence.

`delivered.json` goes from the order to the delivery, with one arrival repeated, and its scans
name couriers, the recipient, branches, phone numbers and pictures. `in-transit.json` ends with
a problem scan that names the recipient, a phone number and a reason.

Waybills, labels after the order creation, status codes, names, places, phone numbers, links
and clocks are invented.
