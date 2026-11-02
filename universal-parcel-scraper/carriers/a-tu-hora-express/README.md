# A Tu Hora Express

A Tu Hora Express is a Spanish home delivery network that carries parcels for retailers and
marketplaces such as Zara, Temu and AliExpress. Tracked through the lookup its tracking page
makes.

## How it works

1. `direct`: `POST https://mydelivery.atuhoraexpress.com/service/envios/detalle-envio-login-guid/{code}/{postcode}`
   with the body `{}`, as the tracking form on mydelivery.atuhoraexpress.com sends a code and
   its delivery postcode. The reply is a shipment record whose only filled field is its internal
   `guid`. Then `POST https://mydelivery.atuhoraexpress.com/service/envios/detalle-envio/{guid}?idioma=ES`,
   also with `{}`, returns the shipment and its scans, newest first. Neither needs a cookie,
   token, captcha or browser.
2. `retry`: one more read when the first fails to reach the tracker or hangs, inside the budget.

- The tracker answers a code only with its own delivery postcode. The 24-digit label ends with
  that postcode, so the adapter asks with the label and the postcode it carries. A 16-digit code
  takes the caller's five-digit postcode, and a ten-digit code is padded with six leading zeros
  first, as the page pads it.
- An unknown code, or a postcode that is not the shipment's, is HTTP 200 with an empty body,
  which the page reports as not found. A 404, a 405 or a redirect is a moved route, and the
  detail route answers an identifier it does not know with a 500.
- The shipment must be the one the lookup named, and its agency code and delivery note number
  must make the sixteen-digit service number asked.
- Recognition gets no postcode, so `tracking.recognition.pattern` limits it to the 24-digit
  label. It makes the same requests.

## Notes

- The catalog declares an optional postcode for a 10- or 16-digit code, so a consumer can ask
  the reader for it. Without one, such a code ends at `input_required` before any request, and
  the facade's enabled fallbacks answer.
- Each scan's status code stages it. Incidents share one code and are worded `Incidencia - `
  and their reason, which decides between a failed attempt and an exception; a reason the map
  and the shared rules do not read is an exception. "Pendiente de realizar" comes with a failed
  attempt at the same clock and moves nothing. [`statuses.json`](statuses.json) records the
  codes and wordings.
- Each scan's `fecHoraAlta` is a wall clock to the second, and the page names no zone, so the
  clocks stay `local_time`.
- A scan's town, `pob`, is kept as its location when set. The page does not show it.
- The page shows `fecEntr` as the expected day only when `boMuestraFechaPrevista` is set and the
  day is not before the departure, and as the delivery day once the status is final. The adapter
  keeps it as `expected_delivery` under the same rule while the shipment is open.
- `pesoOri` is the weight the page shows, kept when above zero.
- Each scan's coordinates, the recipient, the sender, the destination town and address, the
  references, the remarks, the parcel count, the volume, the proof of delivery and the link to
  change the delivery are not kept. The internal identifier opens the parcel without its
  postcode, so it is neither kept nor logged.

## Limitations

- Scan towns are often empty. No service name or pickup point.

## Numbers

The tracker takes a shipment code of 10, 16 or 24 digits and pads a ten-digit code with six
leading zeros to the sixteen-digit form. Public consumer complaints give all three lengths. The
24-digit form is the sixteen-digit number, `001` and the five-digit delivery postcode.

`a-tu-hora-express-1` names the carrier for the zero-padded sixteen-digit form: no other
carrier's sixteen-digit numbers are known to start with six zeros, and recognition cannot ask the
tracker about it without the postcode, so naming the carrier is what lets a consumer offer the
postcode field. `a-tu-hora-express-2` suggests the 24-digit form at low confidence, since other
carriers print numbers of that length; it carries the postcode, so recognition asks the tracker
about it. Ten digits stay unclaimed: many carriers share that length. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker asks for the shipment code and the delivery postcode, then opens the parcel under
its internal identifier, so no address opens one parcel from its number.

## Testing

`npm run test:carriers:live -- carriers/a-tu-hora-express`, with
`A_TU_HORA_EXPRESS_TRACKING_NUMBER` (a 24-digit label) and optionally
`A_TU_HORA_EXPRESS_UNKNOWN_NUMBER`, or `A_TU_HORA_EXPRESS_SHORT_NUMBER` with
`A_TU_HORA_EXPRESS_POSTCODE`, set outside the repository.
