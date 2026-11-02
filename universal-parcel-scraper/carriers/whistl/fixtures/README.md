# Fixtures

`own.html`, `partner.html` and `multi.html` follow the shape of Whistl's Parcelhub tracker:
the shipment's reference as the heading, the sender's and recipient's references, the carrier
and service, then a card for each parcel with its scans, newest first. `own.html` is a parcel
on Whistl's network with a final-mile number, `partner.html` a shipment that another carrier
delivers under its own tracking number and `multi.html` a shipment of two parcels. References,
numbers, depots, signatories, comments and clocks are invented. `not-found.html` is the page
for a reference the tracker does not know and `error.html` the error page it can serve for a
known one.
