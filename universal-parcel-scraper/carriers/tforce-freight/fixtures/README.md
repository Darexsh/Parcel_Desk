# Fixtures

`form.html` is the tracking page before a search, trimmed to the anti-forgery token, the PRO
search with its CAPTCHA switch off, the form the search posts and the empty result area.

`delivered.html`, `in-transit.html` and `not-found.html` are the page after a search for one PRO,
trimmed to its results. `delivered.html` goes from the pickup to the delivery with a failed
attempt and a second delivery run; one service-center scan is repeated, and the appointment
recorded after the delivery is listed below it, as the tracker lists records. It carries a
consignee, a shipper, a signer, an appointment, a bill of lading, a PO number and trailers.
`in-transit.html` waits at the delivering service center for an appointment, with an estimate.
`not-found.html` is the answer for a PRO TForce Freight does not know.

Numbers, names, places, references and clocks are invented. The page's own entity encoding of
text and attributes is kept.
