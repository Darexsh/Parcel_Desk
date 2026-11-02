# Fixtures

`delivered.json` and `in-transit.json` follow the reply of
`/order_management/tracking?order_id={number}` that Quiqup's tracking page receives for an order
number alone, with its state changes oldest first. `delivered.json` is a same-day order collected
from the merchant, missed at the door once and delivered two days later; one depot state change
is repeated, and the collection and the courier's way there share a second, as in Quiqup's
replies. `in-transit.json` is a next-day order Quiqup held, then picked in its own warehouse and
sent out. `not-found.json` is the HTTP 422 answer for a number Quiqup does not know.

Numbers, merchant references and clocks are invented.
