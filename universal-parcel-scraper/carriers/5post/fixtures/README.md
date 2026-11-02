# Fixtures

Each fixture holds the three replies of one guest lookup in 5Post's app: `orders`, the list
`GET /v3/mobile/order-tracking/{number}/orders` returns; `details`, the order's details from
`GET /v3/mobile/order-tracking/{number}/orders/{orderId}`; and `history`, its status history from
`GET /v3/mobile/orders/{orderId}/status-history`, oldest first.

`delivered.json` is a shop's order from abroad: the customs broker's rows, which carry no order
id, two distribution centres, the locker it waited in and its collection. `in-transit.json` is a
parcel one person sent another from a shop's till, which has left a hub. `not-found.json` is the
empty list 5Post returns for a number it has no order for.

Numbers, order and location ids, names, places, addresses, contacts, sums and clocks are invented.
