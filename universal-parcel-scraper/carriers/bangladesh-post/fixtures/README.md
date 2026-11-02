# Fixtures

The `international-*.json` files follow the international tracker's `search1.php` reply: a JSON
string. `international-delivered.json` and `international-in-transit.json` hold the history table
its page shows, scans oldest first, each with its clock, origin and destination countries, office
and event name: mail from abroad delivered, and mail from abroad between offices.
`international-not-found.json` is the page's "item not found" and
`international-database-error.json` its "database error".

The `domestic-*.json` files follow the domestic tracker's `get_data.php` reply: the code, then its
bookings oldest first, each with its scans. `domestic-delivered.json` is an item booked twice, the
older booking returned to the sender and the newer one delivered, with a bag's move and a forward
between offices. `domestic-rolled-back.json` is a delivery a rollback undid, and
`domestic-not-found.json` the reply for a code the tracker has no information on.
`domestic-page.html` is a trimmed copy of the domestic tracker's page with its lookup token.

Codes, offices, office codes, towns, bags, clocks, remarks and the token are invented.
