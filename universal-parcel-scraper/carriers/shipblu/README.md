# ShipBlu

ShipBlu is an Egyptian delivery company for online merchants: it picks orders up from the
merchant, delivers them and collects returns. Tracked through the lookup its tracking page
makes.

## How it works

1. `direct`: one `GET https://api.shipblu.com/api/v1/{list}/{number}/?pin=` in English, as the
   tracking page on `go.shipblu.com` sends it for the number in its address. It needs no
   account, cookie, token, key or browser. The page picks the list by the number's first
   digits: `delivery-order` for 1 and 31, `return` for 2 and 32. The JSON reply has the order's
   current status, its status history with instants, the day the customer chose and the
   delivery instant.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown number is HTTP 404 with `{"detail":"Not found."}`. Another 404, such as Django's
  page for a route the API does not have, or a redirect, is a moved route. A firewall page is a
  challenge and HTTP 429 a rate limit.
- The reply counts only when its `tracking_number` is the whole number asked.
- Recognition makes the same request. No detection rule offers ShipBlu, so preflight does not
  ask it.

## Notes

- Each scan is a status code, such as `en_route`, with an instant and its offset. The code sets
  the stage, as ShipBlu's API documentation defines it, and is worded as it reads ("En
  route"). `in_transit` is a stay at a warehouse and `en_route` a move between two. An unknown
  code goes to the shared wording rules.
- The order's current status sets its stage; one the map does not know leaves the newest
  staged scan's. An order held for the merchant, which the page shows on the step it waits at,
  is an exception.
- A return order goes from the customer to the merchant, so its arrival there is returned, as
  on an order sent back. A courier who could not collect a return moves nothing.
- The estimate follows the page: none before pickup or once the order ended, else the day the
  customer chose, else for a return ShipBlu's estimate. The page asks another endpoint for a
  delivery order's estimate; that endpoint answers a delivered order with the current time, so
  it is not read.
- A missed visit keeps the reason the courier gave, without phone numbers. Other comments, the
  merchant, the recipient's name, phones, address and coordinates, the visit days, the packages
  and the cash to collect come in the same reply and are not read.

## Limitations

- No locations, weight, service or proof of delivery.
- Numbers starting with 4 are cash collections, which carry no parcel; the adapter does not
  look them up.

## Numbers

ShipBlu numbers are digits only: its site accepts seven or more digits starting with 1 to 4,
and its API documentation shows eleven and twelve digits. Such digit runs are common to many
carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking box on `shipblu.com` opens `go.shipblu.com/{lang}/{number}`, with `en` or `ar`;
the library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/shipblu`, with `SHIPBLU_TRACKING_NUMBER` and optionally
`SHIPBLU_UNKNOWN_NUMBER` set outside the repository.
