# Fixtures

`page.html` is a cut-down English tracking page: the CSRF token and header name in its `meta`
tags, the tracking form whose centre field offers the three centre codes, and the script that
sends the token with each htmx request.

The other HTML files follow the fragment the form asks for at
`/htmx-fragment/shipment-trace-by-number-result`: the status, a list of shipment details, then
the scans newest first, each a clock, the depot and the wording.

- `delivered.html`: a single parcel's shipment, delivered, which prints the parcel's number as
  the shipment's.
- `several-parcels.html`: a shipment of two parcels, one put in a parcel locker and one
  delivered, with a scan both parcels share.
- `out-for-delivery-sr.html`: a shipment out for delivery in Serbian, in the older layout that
  lists the scans without a parcel number and shows the sending date and weight.
- `not-found.html`: the notice for a number the tracker does not know.
- `refused.html`: the site's own 403 page for an expired session.

Numbers, towns, depots, postcodes, references, tokens and dates are invented.
