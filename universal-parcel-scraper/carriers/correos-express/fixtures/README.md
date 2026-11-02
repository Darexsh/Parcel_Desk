# Fixtures

`history.html`, `explained.html` and `failed-round.html` follow the shape of the tracking form's
page for one shipment: the heading with the shipment and the estimate, the hidden fields, the
scan table, newest first, and in the first two the delivery PIN block. `history.html` is an
active shipment whose notes are none of the carrier's fixed sentences, `explained.html` the same
shipment with fixed explanations and private notes after them, and `failed-round.html` a
delivered one with a failed round and pickup-point scans. `feed.json` follows the shape of the
Correos localizador's reply for that active shipment: its scans oldest first, each with a date,
a clock to the second, a situation code or none and an explanation, and the shipment's
associated parcel label.

Numbers, places, dates, clocks and notes are invented. The fixed explanation sentences are the
carrier's own. Every private field holds a `PRIVATE_SYNTHETIC` marker that the tests require
never to reach a result.
