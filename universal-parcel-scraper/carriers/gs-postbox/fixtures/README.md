# Fixtures

Each fixture is the page `/invoice/tracking.do` renders, with its `trackingInfo` written twice
in its script, as the tracker serves it. `delivered.html` is a half-price (반값택배) parcel from
store acceptance to its collection at the destination store, with one hub scan repeated.
`in-transit.html` is a half-price parcel at the hub. `handoff.html` is a home delivery
(국내택배) CJ Logistics carries, with CJ's scans up to the departure for delivery; its last
branch names a driver. The found pages carry masked senders, recipients and goods, as the
tracker shows them. `not-found.html` is the answer for a number the tracker has no record of.

Numbers, names, stores, centres, member ids and clocks are invented.
