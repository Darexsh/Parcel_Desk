# Envía

Envía (formerly Envía Colvanes) is a Colombian courier that carries parcels and documents
between Colombian towns through its own network. Tracked through the lookups its tracking page
makes.

## How it works

1. `direct`: `POST https://envia.co/EnviaV2_Api/api/tracking/individual` with
   `{"guiaNumber":"{number}"}`, then `GET https://envia.co/EnviaV2_Api/api/tracking/history/{number}`,
   as the tracking page asks for the guía's record and then its milestones. They need no account,
   cookie, token, key or browser.
2. `retry`: one more try when a request fails to reach the service or hangs. The first try gets
   half of the budget, and its two requests share it.

- An unknown guía is HTTP 404 with `success` false and the message "No se encontró información
  para la guía especificada.", which the page reports as no tracking information. Any other 404,
  a 405, a 410 or a redirect is a moved route. A 403 or a bot check is a challenge, a 429 a rate
  limit and a 503 maintenance. A reply that is not the expected JSON is a changed reply.
- The record and every milestone must name the whole requested guía. One that names another is
  inconclusive.
- Recognition makes the same requests.

## Notes

- The milestones are the page's progress steps, such as "Tu envío está en movimiento.", each with
  a location and a wall clock. Their titles set the stage; the sentence under a known title is
  fixed and left out, and another title keeps it. The record's current state, such as
  "ENTREGADA DIGITALIZADA EN …" with its code, is a scan of its own unless a milestone has its
  clock. Code `13` is a delivery whose proof is filed.
- The clocks have no offset. Envía delivers within Colombia, which keeps one zone without
  daylight saving, and its delivery and out-for-delivery clocks fall in Colombian working hours,
  so scans are returned at `-05:00`. A clock at midnight is a date given without its time of day,
  such as the guía's creation, and stays a `local_time` date.
- The record's `eta` is the expected delivery day until the guía is delivered, and its
  `serviceType` the service name.
- The record also carries the sender's and recipient's names, phone numbers and addresses, the
  amount to collect and a proof-of-delivery image. The adapter does not read them.
- The service can take many seconds to answer for a guía it does not know, so the adapter's
  default budget is thirty seconds.

## Limitations

- The page's detailed view asks for a code sent to the sender's or recipient's phone. The
  adapter does not use it.
- Incident notices (novedades) on the record have no clock and are not kept. The record's
  separate collection, dispatch and delivery-run times are not used.
- No weight, dimensions, pickup point or signatory.
- Older guías drop out of the tracker and then read as not found.

## Numbers

Envía guías are twelve digits; archived lookups on its own trackers show them starting with
a three-digit code such as `014`, `024`, `034` or `126`. Twelve digits are printed by many
carriers and nothing in the number points to Envía, so no rule claims them. The adapter asks
only for twelve-digit guías. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`envia.co/tracking` reads the guía from `?guia=` and looks it up when it opens. The former
tracker on `portal.envia.co` read it from `?Guia=`, and the Envía Colvanes site from `?rastreo=`
on `Contenido.aspx`.

## Testing

`npm run test:carriers:live -- carriers/envia-colombia`, with `ENVIA_COLOMBIA_TRACKING_NUMBER`
and optionally `ENVIA_COLOMBIA_UNKNOWN_NUMBER` set outside the repository.
