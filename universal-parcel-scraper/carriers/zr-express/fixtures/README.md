# Fixtures

The fixtures follow the reply of `GET /suivi?tn={number}` with `RSC: 1`: the page's React
Server Components in French, trimmed of the navigation, footer and translation rows. The answer
box holds a state chip and the number asked, and each step is keyed by its UTC instant and state
code. `delivered.rsc` goes from the check-in to the cash collection, with a delivery run that
ends back at the destination office before the one that delivers. `in-transit.rsc` is a parcel
in delivery at its destination; its newest step's marker and text are rows sent later in the
stream. `not-found.rsc` is the answer for a number ZR Express does not know, and `invalid.rsc`
the answer for one that does not fit its layout.

Numbers, offices and clocks are invented.
