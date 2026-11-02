# Delovye Linii

Delovye Linii (Деловые Линии) is a Russian freight forwarder that carries consolidated cargo
and parcels between its own terminals across Russia and to neighbouring countries. Tracked
through the order search its customer app makes for a guest.

## How it works

1. `direct`: one `POST https://api.dellin.ru/v3/orders.json` with the body
   `{"appKey":"…","deviceId":"…","docIds":["{number}"],"orderDatesExtended":true}`, as the app
   `ru.dellin.cabinet` sends it before anyone signs in. The JSON reply has the order with its
   documents, its state and its dated milestones. A request that fails to reach Dellin is sent
   once more within the budget.

- `www.dellin.ru`, its tracker included, puts Qrator's script check before every page, which
  answers a plain request with HTTP 401 and a page loading `/__qrator/qauth.js`. The API host
  sits behind the same network but answers JSON without the check.
- The app key is the one the app ships for every install. The API refuses a request without a
  key it issued with HTTP 401 and `{"errors":"Unauthorized"}`, read as a refusal of the app's key.
- The device id is one the app mints on its first start: a random UUID whose first, tenth and
  twenty-fifth characters are the first three hex digits of the MD5 of the rest. The API refuses
  an id without them. The adapter mints one per tracker, as one install keeps its own.
- An unknown number is HTTP 400 with error `717001`, "Заказ не найден", so it is not found.
  Other API errors are a changed request, and Qrator's page is a challenge.
- The order must carry the whole number asked: one of its documents, or the order itself.

## Notes

- The milestones (`orderDatesExtended`) are calendar days without a clock: "принят на терминале
  отправки", "прибыл на терминал г. Казань", "доставлен на адрес получения". They stay in
  `local_time` as days. Russia spans eleven zones, and nothing in a row says whose day it is.
  A row the order has not reached yet has a placeholder date and is not kept, nor is a
  calculated row, which is a forecast. A milestone that ends with a town has that town as its
  place.
- The order's `state` decides the stage, and its Russian name is the status text. A state of
  paid storage at a terminal or an airport is cargo waiting there for collection. An order
  without dated milestones is its state alone.
- The reply's calculated schedule (`orderDates`), the origin and destination towns, the
  terminal's address, hours and phones and the order's sums are not kept. A guest gets no
  parties, cargo details or weights; the tracker shows them only after a code sent to a phone
  on the waybill.

## Limitations

- No scan times, only days.
- Finished orders drop out of the API after a while, and their waybills are then not found.

## Numbers

A consignment's waybill is printed as a two-digit year, a hyphen and eleven digits. The
adapter takes it with or without the hyphen and sends it hyphenated; without it, it is the
thirteen-digit order number the tracker's pages show. A pickup request has seven or eight
digits and finds its order too. Thirteen digits are shared by many carriers and nothing in the
number points to Delovye Linii, so no rule claims it. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`www.dellin.ru/tracker/orders/{number}/` opens one order, as archived lookups on Dellin's host
show; older lookups with the hyphenated waybill were redirected there. The search form posts
the number, and archived searches also pass it as `rwID` to `/tracker/`.

## Testing

`npm run test:carriers:live -- carriers/dellin`, with `DELLIN_TRACKING_NUMBER` and optionally
`DELLIN_UNKNOWN_NUMBER` set outside the repository.
