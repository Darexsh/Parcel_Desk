# Fixtures

Replies of the tracker page's lookup, `POST https://servicios.guatex.gt/Guatex/Login/ObtengoTrackingGuia`.

`delivered.json` has the shape of a live reply for a delivered guía of two pieces: code 200, the
guía named at the top, in the summary and in every row, and its rows newest first. The courier's
delivery (`T`) is on the summary's clock, and the same delivery recorded at the agency (`N`)
follows hours later.

`in-transit.json` is a guía that left a warehouse between warehouses. `returned.json` is a guía
that failed delivery twice, the second time with a return, and was delivered back to the
sender. Its failed attempts are dated without a clock.

`not-found.json` is the lookup's answer for a guía it does not know, code 204.

The summaries keep only the fields the adapter reads, with the guía's creation day and piece
count; the reply's other details are left out. The guías, dates, routes, reasons and the
summaries' other statuses are invented.
