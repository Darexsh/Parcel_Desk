# Fixtures

Each fixture holds the five replies the tracking page reads for one guía, by route: `search`
(`/api/buscar/guia`), `label` (`/api/etiqueta/deprati`), `steps` (`/api/estados`, its list as JSON
text), `transit` (`/api/estadosTransito`) and `incidents` (`/api/novedades`).

`delivered.json` goes from collection to delivery, with a transit detail at the same second as
the in-transit step, and a created step dated after the delivery, as the service dates it with
the guía's latest assignment. Its record and label carry a sender, a recipient, a receiver,
addresses, phone numbers and email addresses. `in-transit.json` stops at the in-transit step, with
the delivery-zone step not reached yet. `not-found.json` is the answer for a guía Laar does not
know.

Guías, names, addresses, phone numbers, emails, places and clocks are invented.
