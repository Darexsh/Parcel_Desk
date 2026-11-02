# Fixtures

The pages follow Courier Center's server-rendered result page on its Greek store, cut down to the
shipment's details and its scan table, newest scan first, with the challenge-platform script every
page of the site loads.

`delivered.html` goes from the web order to the delivery across the end of summer time: one bag
scan is repeated, two messages to the recipient carry a masked phone and a link, and the delivery
names who took the parcel. `in-transit.html` is out for delivery again after a failed attempt with
a notice number, under a status that has not settled, and its newest row is an email to the
recipient. `elta.html` is handed to ELTA under an ELTA item code, with ELTA's offices after their
postcodes. `box-now.html` is handed to BOX NOW under a BOX NOW parcel id and collected from a
locker. `not-found.html` is the answer for a number Courier Center does not know, and
`challenge.html` is Cloudflare's browser check.

Numbers, names, phones, links, places, references and clocks are invented.
