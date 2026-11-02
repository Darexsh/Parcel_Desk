# Fixtures

Replies of the mini tracker's `website/mini_track` lookup. `delivered.json` is one consignment
delivered on a day. `in-transit.json` is an order with two consignments: the one asked, received
at BJS's warehouse, and another one booked for a later day. `not-found.json` is the HTTP 400
answer for a reference BJS holds no order for, and `refused-key.json` the HTTP 401 answer to a
request without the page's key.

Numbers, statuses and days are invented.
