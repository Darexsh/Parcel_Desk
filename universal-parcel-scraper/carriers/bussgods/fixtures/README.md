# Fixtures

The replies of `backend.bussgods.se/api/transshipment/{number}`, the lookup the tracking page
makes, with the reply's own fields and order: `Information` about the fraktsedel, then its
`Statuses` oldest first.

- `delivered.json` is a two-parcel fraktsedel booked online, so the information names a product,
  the parcel numbers and the delivery town, and the hand-in scan comes once per parcel. It is
  forwarded twice, once in the hour the clocks go back, arrives at an agent and is handed out
  there; a cash-on-delivery payout follows.
- `in-transit.json` is a fraktsedel without that information: collected from the sender and from
  an agent, left at an agent, forwarded and on its way, with the last scan at the station the
  page names no agent for.
- `not-found.json` is the answer for a number Bussgods does not know.

Numbers, places, agents and clocks are invented.
