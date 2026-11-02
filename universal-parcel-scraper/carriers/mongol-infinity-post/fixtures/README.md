# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the home page's search,
`core_api/api/order/history`: one hit per scan, newest first, each with the whole order, the
sender, the recipient, the couriers, the staff member and the graph of next statuses around it.
`delivered.json` goes from sorting to the delivery, with a failed attempt whose reason holds a
phone number, a repeated hit, and a recipient's name and signature on the delivery.
`in-transit.json` has reached a delivery branch in another town, and its search also hit
another parcel. `not-found.json` is the search's answer with no hit.

`customs.json` follows the reply of the customs lookup the page makes for a number holding YC,
statuses oldest first, released by customs. `customs-not-found.json` is that lookup's HTTP 404
body for an item it does not know.

Numbers, names, phones, addresses, coordinates, references, places and clocks are invented.
