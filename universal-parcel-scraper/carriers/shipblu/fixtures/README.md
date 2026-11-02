# Fixtures

`delivered.json` and `in-transit.json` follow the shape of the tracking page's
`GET /api/v1/delivery-order/{number}/` reply: the order's number and current status, the
merchant, the recipient's name, phones and address with its zone, city and governorate, the
visit days, the customer's chosen day and the estimate, the cash to collect, the pickup and
delivery instants, the hold flag and the status history, each with its instant and comment.

- `delivered.json`: a delivery order delivered on a second round, with a missed visit whose
  comment carries a phone number, a repeated scan and a comment on the delivery.
- `in-transit.json`: a delivery order under a number starting with 31, between two warehouses
  after a missed visit, in winter time, with a day the customer chose.
- `not-found.json`: the body the API returns, with HTTP 404, for a number it does not know.

Numbers, ids, names, places, phones, coordinates, amounts and clocks are invented.
