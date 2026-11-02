# Urbano

Urbano is a Peruvian courier for e-commerce and business parcels, carried by road from its hub in
Lima to its stations across the country and delivered to the door or to Urbano points. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://api.urbanoenvios.pe/api/v1/trackingGlobal` with the JSON body
   `{"guia_barra":"{number}","flag_seller":0}`, the lookup the tracking page on
   `urbano.com.pe/tracking` makes. It needs no cookie, token, key or browser. The reply holds
   one entry per number asked, with the shipment's summary and its movements, newest first.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number the tracker holds nothing for is HTTP 200 with an entry of `error_sql: -1` and the
  number alone, which the page draws as an empty card. The tracker never says the shipment does
  not exist, and it answers an empty or malformed number the same way, so that answer is
  inconclusive (`portal_not_found`), not a missing parcel.
- The shipment must name the whole number asked as its tracking code (`rastreo`), its guía
  barcode or its guía text.
- The service answers a route it does not have with HTTP 500 and Laravel's "could not be found"
  message, read as a moved lookup; any other 500 is inconclusive. A 429 is a rate limit.

## Notes

- Each movement's `auditoria` is the station's wall clock to the minute, with no zone, so it
  stays `local_time`. A courier run can be recorded at 00:00, a day without a clock, so a scan
  at midnight exactly keeps only its day.
- A movement's `chk` code, such as `EN`, is its `provider_code` and stages it. Its wording is
  the `detalle` the page heads it with, then the `sub_estado` the page shows under it, such as a
  failed visit's reason. A movement with neither is an internal note and is left out.
- The shipment's `id_proceso` decides a return (21) and a wait for collection (23, 24), which
  the page labels over its progress rail; the scans decide the rest.
- A movement's station is a code such as `LIM`. The adapter names it after the shipment's origin
  or destination station when the code is one of theirs, and leaves it out otherwise.
- The reply also carries the recipient's name, address, phone, e-mail and ID document, the
  signatory, the contents, the sender, the courier and vehicle of each run, the photos and GPS
  points of each visit and internal manifest numbers. None of them is kept.
- No recognition: the tracker never says a number is unknown, and eight digits or a letter and
  eight digits are shapes many carriers print.

## Limitations

- No instants, delivery time, service or pickup point.
- Urbano Ecuador has its own tracker on `urbano.com.ec`, which the adapter does not read.
- Seller references (`flag_seller` 1) are not asked; the adapter looks numbers up as guías and
  tracking codes, as the page does by default.

## Numbers

Urbano's own guías are a `G` and eight digits; its tracker also takes the eight-digit tracking
code a shipment shows as its Código Rastreo, and the guía barcode, a `WYB` and nine digits.
`urbano-1` suggests Urbano for the `G` layout and stays low because a letter and eight digits is
a generic shape. Eight digits say nothing about the carrier. The adapter sends six to thirty
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`urbano.com.pe/tracking/` followed by the number, or with the number in `?guides=` as the
tracking form builds it, opens one shipment. The older e-tracking page on `app.urbano.com.pe`
reads it from `?guia=`.

## Testing

`npm run test:carriers:live -- carriers/urbano`, with `URBANO_TRACKING_NUMBER` and optionally
`URBANO_UNKNOWN_NUMBER` set outside the repository.
