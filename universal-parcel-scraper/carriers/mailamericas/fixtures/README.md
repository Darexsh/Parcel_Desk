# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/tracking` in English, newest scan
first, with the summary fields the page reads. `delivered.json` goes from a tax ID check to the
delivery, with every leg the tracker names: one hub scan is repeated, a failed attempt comes
before the delivery, and the summary carries a buyer's name, a buyer's tax ID and a proof of
delivery. `in-transit.json` waits at destination customs; its duty-paid scan and a repeated
warehouse scan come before the flight. `mexico.json` is out for delivery in Quintana Roo, whose
clock is not Mexico City's, after the destination offices. `not-found.json` is the answer for a
number MailAmericas does not know.

Numbers, names, IDs, places and clocks are invented.
