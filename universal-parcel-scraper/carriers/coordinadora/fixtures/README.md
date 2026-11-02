# Fixtures

The replies follow the tracker's `tracking/rastreo` lookup for one guide: `estado` holds the
guide's states, the newest of each step, and `novedad` its incidents, both newest first.
`delivered.json` is a full record from a receipt dated without a clock to a delivery, with a
visit that did not deliver repeated, a route delay and a complaint answered. `in-transit.json`
waits at the destination terminal after a unit was sent to the wrong terminal, with an undated
first state and a delay notice newer than the last state. `short.json` is the short record
for an old guide: one dated state, no guide number and a complaint. `not-found.json` is the
reply for a guide Coordinadora does not know, with a complaint filed under the number.
`bad-message.json` is the service's refusal of a malformed guide.

Numbers, towns, codes of terminals and clocks are invented.
