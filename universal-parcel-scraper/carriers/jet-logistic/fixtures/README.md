# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/ajax/checkstatus.php` for one cargo:
its status as text, one line per step separated by carriage returns, oldest first, with a
non-breaking space before `г.` as in the carrier's replies. `delivered.json` is bought goods
collected from the sender and handed out at a town with a hyphen in its name: it has the
payment lines for the goods, a step at a single-digit hour, a handing out dated by its day
alone and the cost of the service. `in-transit.json` has left its receiving warehouse.
`not-found.json` is the answer for a cargo the service does not know, naming its request
number, the last seven digits of the cargo ID.

Numbers, goods, places, prices and clocks are invented.
