# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/public/PublicEnvios/Get/{number}`
with the fields the locator page reads: the shipment's details, its scans, its incidents and its
delivery documents.

`delivered.json` goes from the documentation to the delivery with ISO clocks. A failed attempt is
an incident, one arrival is repeated, one clock carries a fraction of a second, the incident flag
stays set after the delivery, and the details, comments and document link carry a sender, a
recipient, an ID, phones and email addresses. `in-transit.json` has reached the branch that
delivers, with the page's own clock form and a numeric shipment number; two scans share a clock,
one scan's wording carries a phone and an email address, and one has no wording.
`not-found.json` is the reply for a number CBL does not know, and `too-short.json` the reply for a
locator shorter than eight characters.

Numbers, names, IDs, phones, addresses, places, links and clocks are invented.
