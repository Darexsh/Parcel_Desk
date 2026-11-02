# Fixtures

Synthetic replies: codes, offices, towns, clocks, amounts, links and build ids are invented. The
`.txt` files are React Server Components replies of the tracking page's server action: row 0
names the row holding the action's `{ data, error }` result. `not-found.txt` keeps the live
reply for a code the tracker does not know. The other replies carry the fields the page's own
code reads: each item's code, status, origin, destination, delivery date, customs payment
details and scans, each scan with its clock, service area, status key and value, description,
notes and location.

`delivered.txt` is a domestic item whose clocks are Dates, with its delivery scan outlined in
row 2 and referred to twice, as Flight does with a repeated object. `in-transit.txt` is a
domestic item whose clocks have no offset, one with a space for a `T` and one with
microseconds. `inbound.txt` is mail from abroad held for customs, with clocks carrying their
offsets and an unpaid customs payment with its link.

`page.html` stands for the tracking page, which Next also returns, with HTTP 200, for an action id
it no longer has. Its scripts load runtime, vendor, shared and route chunks, and one from another
origin. `route-chunk.js` is its page chunk, which awaits the lookup's action reference and reads
`data` and `error` from the result. `action-chunk.js` is the shared chunk with the module that
wraps `createServerReference` and the module that builds the lookup's reference, next to ids
registered for other actions.
