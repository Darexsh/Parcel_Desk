# Fixtures

`delivered-record.json` and `in-transit-record.json` follow the reply of `/tracking/individual`:
the guía's record with its sender, recipient, payment, dates of the page's progress rail and
current state. `delivered-history.json` and `in-transit-history.json` follow the reply of
`/tracking/history/{guía}`: the milestones, newest first, each with its title, the sentence
under it, a place and a wall clock. The delivered guía goes from its creation, dated without a
time of day, to the delivery, whose clock the record's current state shares. The guía in transit
was made and collected on one day, both dated without a time of day, and its record's current
state is later than its milestones. `not-found.json` is the answer for a guía Envía does not know.

Guías, names, phone numbers, addresses, places, states and clocks are invented.
