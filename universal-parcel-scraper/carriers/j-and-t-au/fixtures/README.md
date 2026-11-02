# Fixtures

`not-found.json` is the reply of `getDetailByWaybillNo` for a waybill J&T Express Australia does
not know: the waybill is left out of `data`. `delivered.json` and `in-transit.json` have the shape
of a found waybill's reply, which the tracking page reads: one answer in `data` that names the
waybill in `keyword` and lists its scans in `details`, newest first, each with a time and a sentence.
The times are in UTC, the zone the adapter's request names.

`in-transit.json` goes from the customs broker to a transit centre with one arrival repeated, two
of its sentences ending with a customer service number. `delivered.json` adds a delivery run and
a delivery whose sentences, modelled on J&T's other trackers, name a depot, the courier, the
recipient and a phone number in brackets.

Waybills, names, depots, phone numbers, the customer service number, the delivery sentences and
times are invented.
