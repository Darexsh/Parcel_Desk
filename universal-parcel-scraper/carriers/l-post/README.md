# L-POST

L-POST (Л-Пост) is the delivery service of the Labirint bookselling holding, with its own
pickup points and couriers for online shops and marketplaces in Russia. Tracked through the
lookups its tracking page makes.

## How it works

1. `direct`: `POST https://l-post.ru/l-backend/tracking` with the body
   `{"OrderTracking":{"trackNumber":"{number}","phoneNumber":""}}`, as the page sends it, finds
   the order. `POST https://l-post.ru/l-backend/tracking/get-order-history` with
   `{"orderData":"{number}"}` then reads its status history, newest first. Neither needs a
   cookie, token, key or browser. A request that fails to reach L-POST is sent once more within
   the budget.

- An unknown number is HTTP 200 with `"error":3`, the page's "Не удалось найти заказ". Only that
  is not found. A 404, a 405 or a redirect is a moved route.
- `"error":2` is the page asking for the recipient's phone number. That is `input_required`;
  the adapter sends no phone number.
- The order must carry the number asked as its `OrderNumber`. Another order is inconclusive.
- The history route answers an empty list for any number, so it is only read for an order the
  first lookup found. An order without history is answered from its summary alone.
- Recognition makes the first lookup only.

## Notes

- The summary's `TXT_Status` is the code of L-POST's API classifier, such as `ACT_CREATED`, and
  `TXT_Status_RU` the status the page heads the order with. The summary decides the stage. An
  `ARCHIVE` summary moves nothing, so the newest staged row decides instead.
- A history row has the page's numeric status id and wording. The ids whose code a reply has
  shown are mapped; other rows are staged by their wording. The page words some statuses
  differently from the API manual: `ACT_CREATED` is "Готово к отгрузке со склада
  Интернет-магазина", the shop having yet to hand the parcel over.
- Rows flagged `isVozvratStatus` belong to a return of the order's items and keep their id
  behind an `R`. They have no stage: a return of the items the recipient refused can follow
  the delivery of the rest. A full return is the delivery's own `CANCELLED`, which is
  `returned` even for an order the shop never handed over.
- At its last-mile point a pickup point delivery is ready for collection, and a courier
  delivery waits for the courier, which stays in transit.
- `DateChange` is a wall clock to the minute without a zone. Pickup points sit in several
  zones, so the clocks stay `local_time`.
- The planned delivery day is the estimate until the order is delivered or cancelled. The
  courier window is not kept.
- The seller is `sender_name`. The pickup point's address and directions are `pickup_point`
  once the parcel waits there or was collected there. A courier order's address is the
  recipient's and is not kept, nor are the shop's order number, the storage deadline, the
  point's phone, coordinates and metro station, or the payment options.
- The reply names no partner, so there is no hand-off.

## Limitations

- No scan locations, weight or delivery time as an instant.
- The page also finds an order by the shop's own number, which the adapter does not take.

## Numbers

The tracking page says a track number is the letters ABC followed by eight digits, typed in
full, and its API manual's examples have that layout. The `l-post-1` rule claims it, and the
adapter takes nothing else. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from its `id` parameter and writes it back there after a
search, so `l-post.ru/tracking?id=` opens one parcel. Older lookups used
`l-post.ru/tracking/order?id=`. The library reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/l-post`, with `L_POST_TRACKING_NUMBER` and optionally
`L_POST_UNKNOWN_NUMBER` set outside the repository.
