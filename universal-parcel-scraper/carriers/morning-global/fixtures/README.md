# Fixtures

`tracking-page.html` is the tracker page cut down to the tracking plugin's section, whose
configuration carries the lookup's nonce, with the site's other nonces in a script beside it.
The JSON files follow the reply of the plugin's WordPress action: one result for the number
asked, with its summary and its scans oldest first. `delivered.json` goes from the order in Hong
Kong to the delivery in Canada, lists one hub scan twice, has hub and flight scans without a
location, and carries a signatory, an origin, a reference, a weight and an estimate.
`in-transit.json` waits at customs in the United Kingdom; its customs scan names an offset the
country's clock did not have then. `no-history.json` is a parcel the tracker knows without scans,
and `not-found.json` the answer for a number it does not know.

Numbers, nonces, names, references and clocks are invented.
