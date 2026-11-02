# TK Energia

TK Energia (ТК Энергия) is a Russian transport company that carries consignments between its
warehouses in Russia, Belarus, Kazakhstan, Kyrgyzstan and China, with collection and door
delivery as options. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://nrg-tk.pro/rest/waybills/states?documentNumber={number}`, as the
   tracking page's script sends it. It needs no cookie, token, key or browser. The JSON reply has
   the receipt's route, weight, delivery window and current states.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The service knows a receipt only with its dash. Consumers pass the number without it, so the
  adapter puts the dash back before the last seven digits.
- An unknown receipt is HTTP 404 with a `NOT_FOUND` reply naming the number. Another 404, a
  redirect or the backend's own 403 for a path it does not serve is a moved route.
- The reply must name the receipt asked: an empty search answers some other receipt.
- Recognition makes the same request.

## Notes

- The reply holds the current states, one per group of places, not a history, so the result is
  a summary. A consignment split between warehouses and trips is as far as its slowest places.
- A state's `movingDate` is a Unix time and is read as an instant: every handing out it dates
  falls in the issuing warehouse's opening hours. The handing out's own `issueDate` runs seven
  hours ahead, Novosibirsk's wall clock written as UTC, and is not used.
- A state's description is its label and sub-state, such as `На складе: В пути`, then the places
  it covers when the consignment is split and a trip's route. The provider code is the state and
  sub-state, such as `1-3`; the map follows the page, which flags a receipt by the labels
  `Выдана` and `Готов к выдаче` and words states 0 and 3 as cargo still with the sender.
- The pickup point is the warehouse holding or handing out the cargo, else the destination
  warehouse. Door delivery has none. The delivery window is kept until the cargo arrives.
- The name of whoever collected the cargo, the warehouses' phones, emails and timetables, the
  prices and the payer are not kept.

## Limitations

- No history, sender, recipient or proof of delivery.

## Numbers

A consignment is tracked by the number of its forwarding receipt: seven digits, optionally after
a branch code of three or four digits and a dash. Gdeposylka lists some receipts ending in `R`,
which the adapter accepts. Without the dash, the four-digit form is eleven digits, which many
carriers share. Bare seven digits and three-digit prefixes also fit other carriers' numbers, so
no rule claims them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`nrg-tk.pro/client/tracking/#{number}` opens one consignment: the tracker page reads the number
from the fragment and writes it there after a search. The old nrg-tk.ru tracker address
redirects to nrg-tk.pro.

## Testing

`npm run test:carriers:live -- carriers/energia-tk`, with `ENERGIA_TK_TRACKING_NUMBER` and
optionally `ENERGIA_TK_UNKNOWN_NUMBER` set outside the repository.
