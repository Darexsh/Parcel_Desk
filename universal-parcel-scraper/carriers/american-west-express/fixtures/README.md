# Fixtures

Each file follows the page `awest.freightgate.com/cgi-bin/tarifftrek5.1/itrek.cgi` opens for one
pro number searched as a pro number, trimmed to the page title, the search form and the page's
script, which assigns the report to `window.JSONReport` and keeps the search in
`sub_condition`.

`delivered.html` holds one shipment from its pickup to its delivery, with its references,
pieces and weight, towns with and without a comma before the state, the ETA to the final mile
agent, the first call to the customer, the appointment and the rail at its last step.
`in-transit.html` is at the final mile agent after the first call, with no appointment yet, the
ETA to the customer and the rail at its third step. `not-found.html` is the search page with the
notice for a number the tracker finds nothing under.

Pro numbers, references, towns, days, pieces, weights and contact details are invented.
