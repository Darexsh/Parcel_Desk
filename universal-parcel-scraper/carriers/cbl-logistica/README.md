# CBL Logística

CBL Logística is a Spanish road transport and logistics company with its own network across
Spain and Portugal. Tracked through the lookup its public locator page makes.

## How it works

1. `direct`: one `GET https://clientes.cbl-logistica.com/api/public/PublicEnvios/Get/{number}`,
   the JSON lookup the locator page on clientes.cbl-logistica.com makes for the number typed in.
   It needs no cookie, token, captcha or browser. A shipment's reply has its details
   (`datos_expedicion`), its scans (`eventos`), its incidents (`incidencias`) and links to its
   delivery documents.
2. `retry`: one more read when the first fails to reach CBL or hangs, inside the budget.

- An unknown number is HTTP 200 with `success: false` and the one server error "No hay datos",
  which the page reports as not found. The error names no number. Any other error is
  inconclusive, and a 404 or a redirect is a moved route.
- The tracker refuses a locator shorter than eight characters with "Longitud incorrecta". The
  adapter asks only for eight to twenty digits.
- A shipment must name the number asked as its `NENVIO`.
- Recognition makes the same request. No detection rule offers CBL, so preflight does not ask it.

## Notes

- The page heads a shipment with its situation code: documented, in transit, at the branch that
  delivers, out for delivery or delivered, or INCIDENCIA instead whenever the shipment carries
  its incident flag. The adapter takes the stage the same way, except that a delivery stays
  delivered under the flag. Without a situation it knows, the newest scan with a stage decides.
- Scans and incidents come without codes. The shared wording rules stage them, and an incident
  they do not read is an exception. Both lists merge into one history, newest first.
- Each scan's `Fecha` is a wall clock without a zone, and the network spans two time zones, so
  the clocks stay `local_time`. The adapter reads the ISO form the reply's serializer writes and
  the page's `dd/MM/yyyy H:mm:ss` form.
- The comment beside each scan is free text that can name who took the parcel, so it is not
  kept. Scan wording loses phone numbers, email addresses and ID numbers.
- The sender, the recipient's name, address and postcode, the customer reference, the remarks,
  the origin branch and its contacts, the weight, volume and parcel count, the pickup and
  delivery dates and the document links are not kept.
- The page's second form also asks for the sender's nine-digit customer code. The adapter does
  not use it.

## Limitations

- No scan location, delivery estimate, weight or service.

## Numbers

Public samples are eleven and twelve bare digits, lengths other carriers share, so no rule
claims them. The adapter takes eight to twenty digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`clientes.cbl-logistica.com/public/consultaenvio.aspx?id={number}` opens one parcel: the
locator page reads `id` from its address and looks the number up on load.

## Testing

`npm run test:carriers:live -- carriers/cbl-logistica`, with `CBL_LOGISTICA_TRACKING_NUMBER` and
optionally `CBL_LOGISTICA_UNKNOWN_NUMBER` set outside the repository.
