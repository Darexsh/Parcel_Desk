# Vozovoz

Vozovoz (Возовоз) is a Russian groupage and freight carrier that also serves Belarus and
Kazakhstan. Tracked through the lookup its tracking page makes for a visitor, which gives the
order's status and dates rather than a scan history.

## How it works

1. `direct`: one `POST https://api.vozovoz.ru/v1/order/mini` with `{"orderID":"{number}"}`,
   the request the tracker page at `vozovoz.ru/order/manage/` sends. It needs no cookie, token
   or account, and Qrator, in front of the site, lets it through. The JSON reply holds the
   order's status message, the flags of its state and its dates.
2. `retry`: one more try after a request that fails to reach Vozovoz or hangs, inside the
   budget. The first try gets half of the budget.

- An unknown number gets one of two answers, and both are not found: error 4033, "Проверьте
  корректность номера заказа.", which the page shows as an error, or an echo of the number
  without a status message, a date or a party, which the page shows as «Нет данных». Orders
  several years old still come back whole, so neither answer stands for an expired order.
  Another error is a changed request, a 404 or a redirect is a moved route, and Qrator's page or
  a 403 is a challenge.
- The lookup also finds an order by its customer's own reference, and then names that order's
  number, so the reply must name the whole number asked.
- Recognition makes the same request.

## Notes

- Visitors get a summary: the order's steps need the phone number of one of its parties or an
  account. The result is marked `summary_only` and holds the status message and the milestones
  the reply dates: the order's creation and, once the order is finished, its issue.
- The issue date comes with the order's final status, which names what it was: the cargo's
  issue, or a finished group pickup, one collection of several orders' cargo from a sender. The
  milestone takes that wording and its stage.
- A status message the map does not know takes its stage from the flags: cancelled, issued,
  arrived at the destination terminal, taken from the sender, else only placed. The arrival
  names no route, so it stays in transit.
- Dates come to the second without a zone. Russia spans eleven zones and nothing in the reply
  says whose clock it is, so they stay `local_time`.
- The page shows the day of `arrivalFrom` as the estimated delivery. It becomes
  `expected_delivery` until the order is issued or cancelled, and is no milestone.
- Only the number, the status and the order's dates are kept; the reply's other details are not.

## Limitations

- No scan history, places or offsets.
- A status between the creation and the issue has no date of its own.

## Numbers

Its tracker asks for the nine-digit number given when the order is placed. The numbers seen in
customer reviews start with the last two digits of the year. Nine-digit runs are printed by
many carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker reads the number from `id` on `vozovoz.ru/order/manage/` and writes it there after
a lookup, so that address opens one order. It is read as a link.

## Testing

`npm run test:carriers:live -- carriers/vozovoz`, with `VOZOVOZ_TRACKING_NUMBER` and optionally
`VOZOVOZ_UNKNOWN_NUMBER` set outside the repository.
