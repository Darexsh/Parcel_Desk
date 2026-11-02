# Fixtures

`app-delivered.xml`, `app-in-transit.xml` and `app-not-found.xml` follow the shape of the replies
the app's tracking service sends: the shipment's details, then its scans newest first, each with a
code, an instant, the office and a comment. `app-delivered.xml` holds the same shipment as
`delivered.html`, with the recipient, shipper, reference, delivery code and the comments the
adapter drops, and repeats one border scan. `app-in-transit.xml` holds the same shipment as
`in-transit.html`, with only its estimate among the details. `app-not-found.xml` is the reply for
an airway bill SMSA does not know: the number and nothing else.

`delivered.html` and `in-transit.html` follow the shape of the English page SMSA's tracker renders
for one airway bill: the language switch and the tracking form, both carrying the number, then the
number, the summary, the progress rail and the scans under their day, newest first.
`delivered.html` crosses a land border into Saudi Arabia, waits at customs and is delivered; its
summary names the origin, the signer, the destination, a weight, a passed estimate and two pieces,
and the page repeats one border scan. `in-transit.html` is a domestic parcel whose summary leaves
the origin, status, destination, weight and pieces empty, as the tracker does for some airway bills;
its newest scan is a missed delivery. `not-found.html` is the notice the tracker shows in place of
a shipment for an airway bill it does not know.

Airway bills, names, towns, weights, codes, comments and clocks are invented.
