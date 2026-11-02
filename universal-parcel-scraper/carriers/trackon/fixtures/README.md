# Fixtures

The replies follow the Android app's `CustDetailTracking` lookup for one AWB number: the
consignment's summary in `summaryTrack`, its scans newest first in `lstDetails` and the lookup's
outcome in `ResponseStatus`. `delivered.json` goes from pickup to delivery, with a repeated
manifest scan, a receiver's name after the delivery wording and proof of delivery and signature
links. `in-transit.json` is back at its delivery branch after a failed delivery whose wording
carries a phone number; its arrival and failed delivery scans come without a code.
`returned.json` goes back to the sender. `not-found.json` is the answer for a
number the service has no consignment for, `not-trackon.json` for a number outside Trackon's
series and `placeholder.json` the empty scan the service gives some numbers it has nothing for.

Numbers, names, phone numbers, references, postcodes, branches, places, weights, links and
clocks are invented.
