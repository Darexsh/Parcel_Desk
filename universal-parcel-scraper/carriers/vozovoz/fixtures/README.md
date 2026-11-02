# Fixtures

Replies of the tracker page's lookup, `POST https://api.vozovoz.ru/v1/order/mini`.

`delivered.json` has the shape of a live reply for an issued order: the number as sent, the
status message with the order's flags, and its creation, estimated arrival window and issue
dates.

`in-transit.json` is an order taken from the sender and not yet issued, with its estimate as a
day, a status description and the customer's own reference. Its status message and description
are invented, so the flags decide its stage.

`not-found.json` is the reply for a number Vozovoz has no order for: an echo of the number
without a status message, a date or a party. `check-number.json` is the reply for another such
number, error 4033.

The numbers, references, dates and parties are invented.
