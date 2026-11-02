# Fixtures

`delivered.json` and `in-transit.json` follow the app service's answer for a waybill: the
waybill's fields, with the sender, recipient, addresses, postcodes, service code, price and
weight, then its scans oldest first. Each scan has the item's number, a state, an action, an
offset-less clock, the office with its code and wording that names the staff member.
`delivered.json` is a domestic waybill from acceptance to a delivery whose wording names the
recipient. `in-transit.json` is an item sent abroad, with a scan that has neither wording nor
office. `inbound.txt` is the answer for an item from abroad the service holds no waybill for: its
empty waybill template, which leaves numeric fields without a value and is not JSON, then the
item's scans. `not-found.json` is the answer for a number the service does not know.

Numbers, names, phone numbers, addresses, offices, office codes, postcodes and clocks are invented.
