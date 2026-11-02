# Fixtures

The files follow the shape of the home page's `GET /wp-json/lp/v1/track?code={code}` reply, the
UPU's IPS record of one item: `MailItemId`, `MatchFound` and the item's `Events` oldest first.
Each event has the IPS event with its number, English name and French name, the office's wall
clock, the country, the office, a mail category, the next office, the reasons an item was kept or
not delivered, and the signatory with the signature.

`inbound-delivered.json` is mail from France held by customs and delivered in Senegal, with a
repeated scan, an office written with a postcode and a signature. `in-transit.json` is an item
posted in Senegal, bagged at the office of exchange. `not-found.json` is the reply for a code
without a match.

Item codes, offices, people, reasons and dates are invented.
