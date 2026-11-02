# CSE

CSE (Курьер Сервис Экспресс) is a Russian courier. It collects and delivers documents and
parcels at the door and through pickup points across Russia, and delivers parcels from China
for marketplaces. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://lk.cse.ru/api/new-track/{numbers}`, as the tracking page on
   cse.ru sends it. It needs no cookie, token, key or browser. `numbers` is a comma-separated
   list of up to ten queries. The JSON reply puts the shipments it found in `found` and the
   queries it did not in `notfound`.

- The tracker finds an order or waybill number only with its hyphens, and the package strips
  them. The adapter asks for the number in CSE's layout and as given, in the one request, so
  references the tracker takes as they are still work. The layout is three digits and the rest
  for 12 and 13 digits, three digits and groups of seven and five or six for 15 and 16, and
  three digits, two letters and the rest for numbers with letters after the first three digits.
- A number is not found only when every query comes back in `notfound`. A redirect, which the
  site sends to its login page, or a 404 is a moved route. A DDoS-Guard or other browser check
  in place of the JSON is a challenge.
- A shipment found by its waybill or a reference echoes the query as its `Number`. One found by
  its order carries the waybill's number instead, and its waybill's creation event names the
  order, so the adapter accepts either and keeps the waybill as the canonical number.
- Recognition makes the same request. With no detection rule, preflight does not ask CSE.

## Notes

- `EventDate` is the recording office's wall clock to the minute, with no zone. Offices across
  Russia's eleven zones record events, so the clocks stay `local_time`.
- The history merges the order's events, from the request to the pickup, with the waybill's.
- The info of an event names couriers, documents, phone numbers and addresses, and is dropped.
  "Информация по отправлению" and "Оформлена добавочная накладная" name only a kind of event,
  so they keep the reason before the colon of their info, as in "Информация по отправлению.
  Получатель/ компания на адресе не найдены", when it has no digits.
- An event's place is the office that recorded it. The registration and the scans in China
  name the office that keyed them in, often Moscow, and are left without a place. A pickup
  point's events take the town from the point's address, because the serving office can be in
  another region.
- Only the address of the pickup point is kept, while the parcel waits there or once it was
  collected from it. The name the info gives the point can carry a person's surname, and the
  point's phones and hours are not kept.
- A supplementary waybill whose reason is "Возврат груза" sends the cargo back, and the
  shipment reads as returned. The page nests that return waybill and its own history in the
  event; the adapter does not read them.
- Wording the map does not know is staged from the English name the reply sends beside it.
  Notes on the shipment, redirections and changes to the order move nothing.
- `PlannedDeliveryDate` is the expected delivery day until the shipment is delivered or
  returned. `Weight` is the weight in kilograms.

## Limitations

- No delivery time as an instant, no recipient, and no return waybill history.
- The sender, the recipient and the shipment's agent link in the reply were empty in every
  reply seen, and are not read.

## Numbers

CSE's tracker takes order and waybill numbers. Its own replies show order-based numbers written
as three digits, a hyphen and nine or ten digits, waybills of eight or thirteen digits, and
longer numbers in three hyphenated groups. Detection strips hyphens, so every layout becomes a
plain run of digits that many carriers share, and CSE has no rule. Marketplace and partner
references that the tracker also answers belong to the parties that issued them.

## Links

cse.ru opens a search at `/{city}/track/` with the number in the `numbers` parameter; the city
code changes with the visitor's region. The page looks the number up as given, so a number
without its hyphens finds no order or waybill there. The former `track.php` page took the
number in its `number` parameter.

## Testing

`npm run test:carriers:live -- carriers/cse-russia`, with `CSE_RUSSIA_TRACKING_NUMBER` and
optionally `CSE_RUSSIA_UNKNOWN_NUMBER` set outside the repository.
