# Fixtures

The `order-*.json` files follow the reply of `POST /l-backend/tracking`, and the `history-*.json`
files the reply of `POST /l-backend/tracking/get-order-history`, newest status first.

- `order-pickup-delivered.json` is a pickup point delivery the recipient collected, inside
  `trackingData` as the backend sends one, with the shop's order number, the point's phone,
  coordinates, metro station and storage deadline, and the payment options.
  `history-delivered.json` is its history: one row is repeated, and two rows of a return of some
  items come after the collection.
- `order-courier-in-transit.json` is a courier delivery waiting at its last-mile point for the
  courier, flat in `data` as the backend sends one, with the recipient's address and the
  delivery window. `history-in-transit.json` is its history.
- `not-found.json` is the answer for a number L-POST does not know.

Status ids 1 and 4 are the page's own and the other ids are invented. Statuses the page has
not been seen to word carry the wording of L-POST's API manual. Numbers, names, addresses,
phone numbers, places and clocks are invented.
