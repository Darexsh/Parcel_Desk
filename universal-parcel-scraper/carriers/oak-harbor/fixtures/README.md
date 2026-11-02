# Fixtures

`delivered.html` and `in-transit.html` follow the shape of the fragment
`www.oakh.com/tracingactions.php` returns for `loadTraceDetails` and one PRO: the number it
looked up in hidden fields, the shipment's information, the trace history with the terminals'
tooltips and phone numbers, and the form to request documents by email. `delivered.html` has a
refused delivery, a repeated row and an appointment before the delivery. `in-transit.html` is a
shipment received from a partner, with an estimate. `support-notice.html` is the fragment with the
support notice the tracker gives for an unknown PRO, and `not-found.html` the same fragment with
"Pro Not Found". PROs, references, parties, places, terminals, phone numbers, signers and clocks
are invented, and the fragment's styles are cut down.
