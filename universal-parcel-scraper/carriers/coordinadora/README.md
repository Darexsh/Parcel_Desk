# Coordinadora

Coordinadora Mercantil is one of Colombia's largest parcel carriers. It carries parcels and
freight between its terminals across the country and delivers to the door or to Droop pickup
points. Tracked through the lookup its tracker at `rastreo.coordinadora.com` makes.

## How it works

1. `direct`: one `POST https://apiv2.coordinadora.com/tracking/rastreo` with the body
   `{"guias":["{number}"]}`, as the tracker sends it. It needs no cookie, token, key or
   browser. The JSON reply lists one record per guide: its states, the newest of each step of
   the tracker's rail, and its incidents (novedades), both newest first.

- An unknown guide is HTTP 200 with the single state `0`, `GUIA NO EXISTE`, which the tracker
  reports as not found. A 404 or a redirect is a moved route.
- The service refuses a guide that is not eleven digits with
  `{"isError":true,"code":"BAD_MESSAGE"}`. The adapter checks the number first, so that refusal
  means the request no longer fits.
- A full record names its guide, which must be the one asked. Old guides, and some numbers
  never used, get a short record without the number, holding only their states; the request
  names one guide, so the adapter takes it.
- Recognition makes the same request.

## Notes

- Clocks are a date and a time of day without an offset. Coordinadora works within Colombia,
  which has one zone without daylight saving, so they are read in Bogotá time to the second.
  A state the reply marks international keeps its wall clock.
- The first state, `A RECIBIR POR COORDINADORA`, is dated without a time of day, or not dated at
  all; its date stays a date. A guide whose only state is undated is a summary without scans,
  which recognition does not count: the service answers some made-up numbers that way.
- A scan's description is Coordinadora's Spanish wording and its code stages it. States are
  one digit and incidents three, as the tracker's script maps them. A route delay and the
  notice that a delivery will take longer move nothing.
- A delivery stands over an incident reported after it.
- The tracker also lists complaints filed under the guide (`reportes`) and the date
  Coordinadora answered them. They repeat the incidents, and an unknown number can carry
  hundreds filed by people who mistyped it, so the adapter does not read them.
- The reply's towns, product code, Droop pickup point with its address, hours and phone, and
  any new guide made after an incident are not kept.

## Limitations

- No location per scan, estimate, weight or service name.
- A guide closed by an incident can continue under a new guide, which the tracker links to;
  the adapter does not follow it.

## Numbers

Coordinadora tracks a shipment by its guide number (número de guía), which its tracker accepts
as eleven digits. Eleven bare digits are printed by many carriers and nothing in the number
points to Coordinadora, so `coordinadora-1` only suggests it, and recognition asks Coordinadora
only when the lookup's country is Colombia: abroad, GLS prints the same eleven digits.

## Links

The tracker `rastreo.coordinadora.com/?guia=` followed by the number opens a shipment. Older
pages on `coordinadora.com` and `rastreos.coordinadora.com` take the guide as a parameter or
as the last path part.

## Testing

`npm run test:carriers:live -- carriers/coordinadora`, with `COORDINADORA_TRACKING_NUMBER` and
optionally `COORDINADORA_UNKNOWN_NUMBER` set outside the repository.
