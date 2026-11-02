# Fixtures

`delivered.json` and `returned.json` follow the shape of the tracking service's shipment reply:
the shipment, its parcels and their scans newest first with a Slovak wording, a numeric code, a
wall clock, a depot and the handheld's coordinates. `delivered.json` is the full view, with the
sender, the recipient, a reference and remarks the adapter must not read; `returned.json` is the
limited view, with depots and millisecond clocks. `pending.json` is a shipment without scans whose
parcel carries a dashed number, and `parcel-status.json` the scans the service gives for it.
`upstream-error.json` is the service's answer when it cannot return a shipment, and
`not-found.json` the search's notice for an unknown number. Numbers, names, places, references,
remarks, coordinates and clocks are invented.
