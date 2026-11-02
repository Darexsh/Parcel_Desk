# Fixtures

The fixtures follow the replies IDS's tracking page reads: the shipment record of its
`/api/shipping/status` lookup, with the fields the page's script reads, and the partner list
of `/api/ids/partner`.

`delivered.json` goes from the pickup to a delivery after one failed attempt. It holds a
pickup scan repeated two minutes later, which the page shows once, a scan whose code the page
has no sentence for, a delivery appointment filed at the collecting depot, which the page
moves to the delivering one, and a linehaul manifest time in its header. Its free-text fields
name the recipient. `in-transit.json` arrived at the delivering depot in the hour the clocks
repeat when they go back, and holds an arrival code at the collecting depot, which the page
does not show. `not-found.json` is the empty record the lookup returns for a number it has no
data for under the postcode. `partners.json` names two depots' towns, and a third depot
without one.

Numbers, postcodes, depot ids, names, towns, addresses, notes and clocks are invented.
