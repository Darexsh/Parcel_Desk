# Via Cargo

Via Cargo is an Argentine parcel and freight carrier. It carries shipments between its branches
and agencies across the country, for collection there or delivery to the door. Tracked through
the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://ws.busplus.com.ar/alerce/tracking?NumeroEnvio={number}&tokenRecaptcha=`,
   as the script of `formularios.viacargo.com.ar/seguimiento-envio/{number}` asks for the number
   in its address. The request carries the page's own `PUBLIC-KEY` header, the same for every
   visitor. The page also sends a reCAPTCHA token, which the service does not check, so the
   token is left empty; the request needs no cookie or browser. The JSON reply lists the
   shipments found under `ok`, each with its service, weight and events, newest first.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 200 with an empty `ok` and no `errores`, which the page reports as
  no data for the number. Errors in `errores` make the lookup inconclusive. A 404 or a redirect
  is a moved route.
- The service refuses a request without the page's key with HTTP 403, read as a challenge, as
  is a firewall's browser check in place of the reply.
- The reply has room for a reCAPTCHA score, which the service leaves empty. An empty reply with
  a score could be a refused token rather than a missing shipment, so it is a challenge too.
- A shipment counts only when its own `numeroEnvio` is the number asked.
- Recognition makes the same request.

## Notes

- Each event's `fechaEvento` is the branch's wall clock to the minute. Via Cargo carries parcels
  only within Argentina, which has one zone without daylight saving, and its intakes and
  deliveries fall in working hours, so scans are read in Buenos Aires time. The page shows
  `fechaAlta` instead, the minute the event was entered, which can come hours later; it is used
  only when `fechaEvento` is missing.
- The summary's admission and delivery times are on a twelve-hour clock without AM or PM, and
  the delivery one is the arrival at the destination branch, so neither is read.
- An event's description is its fixed Spanish wording and its `tipoEvento` stages it; another
  type falls to the shared wording rules. `RECIBIDO EN DESTINO`, the arrival at the destination
  branch, stays in transit: the reply does not say whether the parcel waits there for collection
  or goes out to the door. The location is the branch's name.
- The customer requests the page lists under the history, the parcel count and the parcels'
  states are not kept, and neither are the sender's and the recipient's details nor who took
  the parcel.

## Limitations

- No delivery estimate, and no proof of delivery.

## Numbers

Via Cargo shipment numbers seen on its own trackers are twelve digits starting with `999`.
Other carriers in the corpus print twelve-digit numbers with the same start, so no rule claims
them. Recognition can tell a known number from an unknown one, but without a rule offering Via
Cargo it is not asked; a caller names the carrier or pastes a tracking page link. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

`formularios.viacargo.com.ar/seguimiento-envio/<number>` opens one shipment: the tracker reads
the number from its path and searches it. Older trackers on `viacargo.com.ar` carried it in
`/tracking/<number>` and `/api/tracking/<number>/`.

## Testing

`npm run test:carriers:live -- carriers/via-cargo`, with `VIA_CARGO_TRACKING_NUMBER` and
optionally `VIA_CARGO_UNKNOWN_NUMBER` set outside the repository.
