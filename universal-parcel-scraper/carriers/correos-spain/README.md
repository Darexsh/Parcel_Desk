# Correos

The Spanish postal operator. Tracked through the keyless `localizador.correos.es`
traceability service. Correos Express (`correos-express`) and
Correos de Chile (`correos-chile`) are separate carriers.

## How it works

1. `direct`: one `GET https://localizador.correos.es/canonico/eventos_envio_servicio/{code}`
   with the web channel's parameters (`codAplicacion=60&codCanal=3&indUltEvento=N`) and
   `codIdioma`: `ES`, `PT` or `FR` for a lookup whose `language` is Spanish, Portuguese or
   French, `EN` for any other. No cookies, token or account. The HTTP status is always 200;
   the envelope decides:
   - The body is a single-element array, or a bare object for some error bodies. The echoed
     `codEnvio` must match.
   - `error.codError` `0` is a real answer. Any other code (e.g. `3`, "Sin Trazabilidad en
     Minerva", with `eventos: null`) means unknown or not yet scanned: `NotFoundError`.
   - `codError` `0` with no events is `unknown`, with `resumen_ultimo` as the status text.
   - Non-200 is `UpstreamHttpError`.

   The localizador only knows parcel codes. An expedition code is resolved first with one
   `GET https://api1.correos.es/digital-services/searchengines/api/v1/envios?text={code}&language=ES`,
   the keyless search behind the public tracker. It lists the expedition's parcels and answers
   204 for a code it does not know. The parcel is then tracked as above, and its envelope must
   name the expedition in `codExpedicion`.

   While the parcel awaits collection, the envelope names the office (`nom_codired`) and gives
   its unit code (`codired`), but not its address. The office locator on correos.es adds it with
   one keyless `GET https://api1.correos.es/digital-services/searchloc/api/v1/offices?text={nom_codired}&searchType=otros&specialSearch=true&sendDelivery=OFI&distance=10000`.
   It gets at most three seconds and half of the time left; any failure leaves the name alone. A
   tracker remembers the addresses it has read.

## Notes

- Detection covers checksum-valid `…ES` S10 numbers, `PR` + 15 digits + `C`, and the
  23-character codes: a product prefix (`P…` parcels such as `PQ`, `PK`, `PH`; `D…`
  returns; `CD` certified letters; others such as `L3`, `UX` and `VE` on Correos's tracker), a
  4-character label code, 16 digits and a check letter. The prefixes vary, so the check letter
  gates the rule. The last seven digits are the package number and the destination postcode.
  Correos Express's all-digit 23-character numbers don't match. The adapter itself accepts any code
  and lets the envelope decide.
- The localizador serves the whole Correos group. An all-digit number whose coded scans are all
  Correos Express situation codes (`X…`) is refused as invalid input with the reason
  `other_carrier`: Correos's own codes carry
  letters, and the shipment is [Correos Express](../correos-express/README.md)'s, whose adapter
  reads the same localizador beside its form. A universal provider naming Correos for it does
  not make it Correos's.
- An expedition code is the 16-character number Correos gives a sender for a whole consignment:
  the first fifteen characters of its parcel code and a check letter of its own.
- The check letter of both codes is `TRWAGMYFPDXBNJZSQVHLCKE` at the sum of the other
  characters' codes modulo 23. Correos publishes no formula; this one holds for every public
  code in `numbers.json`. Detection and the adapter share it through
  `core/detection/correosSpain.ts`. A sum cannot see two characters swapped.
- An expedition of several parcels is inconclusive: one parcel's history does not describe the
  others. Each parcel can still be tracked by its own code.
- The search endpoint is not used for history. Its events carry Spanish text and a phase but no
  `codEvento`, the only field the status map reads.
- Only `codEvento` is mapped, never the `desTextoResumen` prose. Each event keeps it as
  `provider_code`, so the app reviews an unmapped scan by its code. `statusMap` answers by code,
  and by wording only for `G01L020V`, which the queue held before events kept their code.
- The localizador words its scans in the language `codIdioma` names, whatever `Accept-Language`
  says: English, Spanish, Portuguese or French, and Spanish for any other code, Catalan, Galician
  and Basque included. Codes and clocks are the same in each. A scan stored in one language takes
  another's wording in place: at its instant, its code identifies it. In English the failed
  attempt `H06P010V` reads "In delivery", like the out-for-delivery codes. So does `H01C120V`,
  seen while the parcel waits at a post office for collection: it keeps the stage of the scan
  before it and never becomes the summary.
  The collection from a pickup request's address, `HI10002V`, has no English summary, so the
  adapter gives it one worded from the Spanish, in any reply that leaves it without one.
- `A090000V` ("Pre-registered") is the sender's pre-registration and stays `registered`;
  `A010000V` ("Accepted") is Correos taking the parcel in, `accepted`.
- `L010000V`, `I010000V`, `X120000V` and `EOL.9001` come from a community integration and
  were never re-observed (`EOL.9001` does not even match the Correos code shape). They are
  kept because they cost nothing: any other unmapped code still reports `unknown` and the
  sync records it.
- Times come split as `fecEvento` (`DD/MM/YYYY`) and `horEvento` (`HH:MM:SS`, midnight when
  absent) and are read as `Europe/Madrid`.
- A unit code opens with its province's two digits, as the office locator lists them. When the
  envelope's `codired` is on the Canary Islands (35 or 38), the delivery unit's scans carry the
  islands' wall clock and are read as `Atlantic/Canary`: `G` and `H` codes but the collection
  `HI10002V`, `L0`, `O13` and the delivery. Once the parcel is handed back to its sender, the
  envelope may name the sender's unit, so they stay on Madrid's clock.
- The catalog zone is `Europe/Madrid` too. ParcelsApp ("Spain Post") and Ship24 ("Correos de
  España") relay the same wall clocks without a real offset, so they are read on that clock and
  land on the instants the adapter gives, except an origin post's scans (below).
- On an item from abroad, the origin post's scans, at its outward office of exchange
  (`B030000V`) and in its customs (`B170000V`), carry that post's wall clock: India Post's own
  scans have the same minutes on Kolkata time, and Japan Post's on Tokyo time, where Madrid's
  put them hours late. The country the S10 code's suffix names gives their zone, or they keep
  `local_time` when it has several. The identity policy in [identity.ts](identity.ts)
  (`relabelledFrom: 'Europe/Madrid'`) lets such a scan take over the row stored under the
  Madrid reading, by wall clock and code. `C010000V` and the later codes stay on Madrid's
  clock: on an item from abroad, the departure from the exchange office came after the
  arrival in Spain.
- 17TRACK, ParcelsApp and Ship24 give no event code, so their copies of those scans are told
  by Correos's summaries, "En oficina de cambio", "En aduana de origen" or "In the exchange
  office", and read the same way ([clock.ts](clock.ts)). Postal Ninja translates the
  wording, so its copies stay on its usual reading.
- The office (`nom_codired`) becomes `pickup_point` only while the parcel awaits collection.
  On a delivered parcel it is where the parcel *was* held and would read as a false pickup
  instruction.
- The locator places its search text and lists the offices around that place; it finds nothing
  for a unit code, so the office is searched by name. Its `officeId` is the unit code (correos.es
  books an office's appointments with it as `codired`), and only the office whose `officeId`
  equals the envelope's `codired` is read: its `address`, then `postalCode` and `cityName`, on
  the lines after the name. A branch named only by its town and number is placed at the town's
  centre, so the search covers 10 km instead of the website's 5. Phone, email, hours and
  coordinates are not read.
- Weight (`peso`, grams → kg) and dimensions (`largo`/`ancho`/`alto` → `L x W x H cm`) are
  kept: operational data users check against a merchant listing. Some international items give
  the sides in metres; when all three are below 1 they are converted to centimetres.
- `nombre_cliente` is not projected: for a private recipient it is a person's name. Address,
  phone and signature blocks are never read; a test asserts it.
- At most 20 events are returned, newest first.
- Not used: scraping `correos.es/.../detalle`. It is a JavaScript app and its HTML carries no
  history.

## Limitations

- No delivery estimate and no event locations. The keyless search gives each scan's unit code
  (`codired`) but no name or town, and the locator finds offices by place, not by code.
  `GET https://api1.correos.es/admissions/admmae/api/v1/deliveryUnit/{codired}` gives any unit's
  street, postcode and town, but answers 401 without the client keys correos.es sends, and no
  agreement covers those.
- An office the locator does not place within 10 km of its name keeps its name alone.
- Events carry no unit of their own. Canary Islands scans before the delivery unit, such as an
  admission or a sort on the islands, are read as Madrid time and can be one hour off, as are
  relays' copies of the delivery unit's scans.
- On an item bound abroad, the destination post's scans (`F010000V` to the delivery) are read as
  Madrid time too: the reply does not name the destination.

## Testing

`npm run test:carriers:live -- carriers/correos-spain`. The unknown-number
checks need no env vars; set `CORREOS_SPAIN_DELIVERED_TRACKING_NUMBER` to also check a real
delivered parcel, `CORREOS_SPAIN_EXPEDITION_CODE` a real single-parcel expedition and
`CORREOS_SPAIN_PICKUP_TRACKING_NUMBER` a real parcel awaiting collection at an office.
