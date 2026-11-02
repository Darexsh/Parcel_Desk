# Servientrega

Servientrega is Colombia's largest courier network. It carries documents and parcels between
its logistics centres across the country and delivers to the door. Tracked through the guide
lookup its app makes.

## How it works

1. `direct`: one `POST https://apim-servientrega-prd.azure-api.net/portal-rastreo/api/ControlRastreovalidaciones`
   with the body `{"numeroGuia":"{number}","idValidacionUsuario":"0","tipoDatoValidar":"0","datoRespuestaUsuario":"0","idpais":1,"lenguaje":"es"}`,
   as the Servientrega app sends it. It needs no cookie, token, key or browser. The JSON reply
   holds the step the tracker reached and one result: the guide's record, with its overall
   state and its movements, oldest first.

- An unknown guide is HTTP 200 with the single result `null`. A 404 or a redirect is a moved
  route.
- The service can ask for a captcha, a code or a choice among masked contact details before it
  shows a guide. The adapter reads those steps as a challenge.
- The record names its guide, which must be the one asked. The service reads the number as a
  decimal, so leading zeros name the same guide.
- Recognition makes the same request.

## Notes

- The tracking page at `servientrega.com` loads its result in a frame from
  `mobile.servientrega.com`, which does not answer connections from Europe, North America or
  Asia. The app's lookup goes through Servientrega's API gateway, which does, and returns the
  same record.
- Clocks are a date and a time to the minute without an offset. Servientrega carries parcels
  within Colombia, which has one zone without daylight saving, so a guide whose origin and
  destination are both Colombia has its clocks read in Bogotá time. Another guide keeps its wall
  clocks.
- A movement's description is Servientrega's Spanish wording, followed by the reason in
  brackets when it logs one, and its process code stages it. A movement repeated with the same
  clock, code, wording and town counts once.
- The guide's overall state `ENTREGADO` stands over a movement logged after the delivery. The
  delivery time is the guide's own, which is the courier's report; a verified delivery follows
  it. On a guide `ENTREGADO A REMITENTE`, delivered back to its sender, the deliveries are the
  return's and the guide is returned.
- The service names the product, kept as the service name. The record's names, addresses,
  emails, phones, identity number, proof-of-delivery picture, signatory, weight, amounts,
  invoice, customer-service tasks and the courier of each movement are not kept.

## Limitations

- The record's estimated delivery date came empty in every reply, so there is no estimate.
- The tracking page also looks shipments up by sender reference (remisión) or invoice through
  other services; the adapter takes guide numbers only.

## Numbers

Servientrega tracks a shipment by its guide number (número de guía), ten digits in regulator
decisions and archived lookups, with some older nine-digit guides. Bare digit runs of these
lengths are printed by many carriers and nothing in the number points to Servientrega, so no
rule claims them.

## Links

The tracking page `servientrega.com/wps/portal/rastreo-envio/detalle?id=` followed by the
number opens a shipment. The older
`servientrega.com/wps/portal/Colombia/transacciones-personas/rastreo-envios/detalle` page takes
the same parameter.

## Testing

`npm run test:carriers:live -- carriers/servientrega`, with `SERVIENTREGA_TRACKING_NUMBER` and
optionally `SERVIENTREGA_UNKNOWN_NUMBER` set outside the repository.
