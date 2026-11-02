# Fixtures

`delivered.json` and `in-transit.json` follow the shape of the tracker's
`GET /api/v1/public/order/{number}/history_items` reply: the order's history items newest
first, each with its status code, its English wording (none for `created`), a UTC instant, and
the courier or the warehouse and its town. `delivered.json` is a delivery after a failed attempt,
each attempt logged at the same instant as its outcome. `in-transit.json` is an order sent on
between two warehouses, with a bare update as its newest item. `not-found.json` is the 404 reply
for an ID the tracker does not have.

Codes and wordings are the tracker's own. Ids, courier names, warehouses, towns and clocks are
invented.
