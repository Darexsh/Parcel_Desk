# Fixtures

Replies of the tracking page's lookup, `POST /site/trackload_end?send=1`, and the page that
opens its session.

`page.html` keeps what the adapter reads of the tracking page: the CSRF meta tags and the
tracking form with its hidden token, beside the feedback form's captcha script.

`delivered.json` has the shape of a live reply for a consignment collected at the receiving
terminal: the number as sent, the steps oldest first with their codes, wordings and short
labels, the route's cities, the terminal's address, phone and hours, and the delivery details
with the receipt, the payment, the cargo and the addresses.

`in-transit.json` is a consignment going on to the door: the six-step route with a delivery
ordered, its steps as an object, which the page reads alike, an `F2` estimate and a day
written without its leading zero, which the page's script pads. The estimate's wording is
invented.

`not-found.json` is the reply, with HTTP 404, for a number KIT does not know.

Numbers, places, addresses, phones, references, weights and clocks are invented.
