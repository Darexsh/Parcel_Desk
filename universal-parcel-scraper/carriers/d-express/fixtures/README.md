# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's `task=search`
lookup, in its JSON escaping: the code, the summary as HTML with the recipient masked as the page
masks it, and the scans oldest first. `delivered.json` is picked up, out for delivery twice and
delivered after the clocks go back; its first two scans share a second and come in the reply's
reversed order. `in-transit.json` waits in a centre's warehouse after a failed delivery attempt,
in the former tracker page's wording. `not-found.json` is the answer for a code D Express does
not know.

Codes, names, towns, phone numbers, status icons and clocks are invented.
