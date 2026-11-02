# Fixtures

Each file follows the shape of the HTML fragment Correo Argentino's tracking forms receive for a
number. `delivered.html` and `in-transit.html` answer the national form, with Correo Argentino's
history newest first; `in-transit.html` also carries the customs box and the import footnote.
`inbound.html` and `returned.html` answer the international form: the IPS history oldest first,
then the national history under the number the item was given in Argentina. `not-found.html` is
the notice for a number without results, and `blocked.html` a firewall's page in place of a reply.
Numbers, plants, offices and clocks are invented.
