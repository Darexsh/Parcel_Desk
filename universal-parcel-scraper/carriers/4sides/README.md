# 4Sides

4Sides is a Moscow and Saint Petersburg courier for corporate documents and freight, which it
delivers across Russia and abroad. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://4sides.ru/api/tracking?number={number}`, as the tracking page
   sends it. It needs no cookie, token, key or browser. The JSON reply has the waybill's summary
   and its events, oldest first.
2. `retry`: the same request once more when the first fails to reach 4Sides or hangs. The first
   gets half of the budget.

- An unknown waybill is HTTP 200 with `Не найдено` and the number in place of the number, and
  empty fields, which the page reports as not found. A 404 or a redirect is a moved route.
- The lookup checks the number as the page does and refuses any other shape with HTTP 400, so
  it never answers part of a number. The adapter sends only whole waybills, and reads a refusal
  as a changed rule.
- The reply must echo the number asked, in its not-found answer too.
- Recognition makes the same request. With no detection rule, preflight does not ask 4Sides.

## Notes

- Events are dated to the day as `dd-mm-yyyy`, with no time or zone, so each is a `local_time`
  day.
- The tracker words an event as the event, then in brackets the shipment's state and labelled
  clauses, as in `Приём (В СЦ, в городе: …)`. The adapter keeps the event and the state; the
  town becomes the event's place. The clause naming who took the parcel and any other clause
  are dropped.
- The event stages a scan. `Приём` is the intake at a sorting centre, which histories show at
  the destination after the departure from Moscow, so it is in transit and the collection
  (`Сбор`) is the acceptance. A delivery attempt is delivered when its state is `Доставлено`,
  and failed otherwise.
- `deliveredDate` is the delivery day. The page reads a waybill with one as delivered whatever
  its last event, and so does the adapter, unless the last event is a delivery or a return.
- `weight` is the weight in kilograms. `receiverCountry` names the destination country in
  Russian.
- The recipient, who took the parcel, the kind of shipment, the contract, the tariff and the
  sender's and recipient's towns in the reply are not kept.

## Limitations

- No scan times, no delivery time as an instant and no estimated delivery.

## Numbers

4Sides' waybill barcode, as its
[label rules](https://4sides.ru/documents/legacy/4S_Pravila_zapolneniya_adr_blanca.doc) and its
tracker describe it, is `FS` or `FE`, nine digits and `RU`: the UPU S10 layout with Russia's
code, although 4Sides is not a postal operator. The adapter takes only that whole layout, as the
tracker does.

Postal detection claims these numbers when their check digit holds, and no rule names 4Sides.
A rule such as `jersey-post-s10` would need evidence that Russian Post does not use the `FS` and
`FE` service indicators, and the UPU's S10 standard now gives `FA` to `FZ` to the posts'
proof-of-delivery service
([version history](https://www.upu.int/UPU/media/upu/documents/Standards/UPU-Technical-Standards-version-history.pdf)),
so the gap stays. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the waybill number from its `number` query parameter and looks it up
on load, so that address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/4sides`, with `FOURSIDES_TRACKING_NUMBER` and
optionally `FOURSIDES_UNKNOWN_NUMBER` set outside the repository.
