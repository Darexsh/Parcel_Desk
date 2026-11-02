# Chilexpress

Chilexpress is a Chilean express and parcel carrier with a national network of branches.
Tracked through the lookup its help centre's tracking page makes.

## How it works

1. `direct`: the adapter reads the help centre's page at `https://centrodeayuda.chilexpress.cl/`
   and the `main.*.js` script it names, which holds the gateway key and the app client the page
   signs in with. It then posts a client-credentials grant to
   `https://services.wschilexpress.com/centroayuda/api/v1/api/v1/token` and sends
   `GET .../gettracking?ot={number}` with the bearer token it returns. Both requests carry the
   gateway's `Ocp-Apim-Subscription-Key` and the help centre's `Origin`. The JSON reply has the
   order's summary (`DatosOT`), its scans (`ListTracking`) newest first and the outcome
   (`Respuesta`).
2. `refresh`: when the tracking request answers 401, the adapter signs in again and repeats it.
3. `retry`: a request that did not reach the service or timed out is tried once more with the
   rest of the budget.

- The help centre's `/pre-seguimiento/{number}` page signs every visitor in with the values in
  its script, with no captcha, cookie or customer account, then makes the same lookup. The
  adapter reads them from that public page at runtime and keeps them. When the gateway refuses
  values read over an hour before, it reads the page once more. A page or script without them is
  a changed page. The adapter keeps the token for the hour it lasts.
- The gateway answers 403 to a request without the help centre's `Origin`. A refused sign-in is
  a block, not a missing order.
- An unknown order is HTTP 200 with `resultado: false`, no message and no scans, which the page
  reports as not found. `resultado: false` with a message is the service failing and stays
  inconclusive. A 404 or 410 is a moved route.
- Every scan must name the order asked. The service reads the number as an integer, so leading
  zeros do not change it.
- Recognition makes the same lookup.

## Notes

- Each scan's `fec_track` is a wall clock with no zone. Mainland Chile follows
  `America/Santiago`, Magallanes keeps summer time all year and Easter Island runs two hours
  behind the mainland, and the reply does not say which applies, so the clocks stay
  `local_time`.
- A scan keeps its Spanish wording and its event type (`cod_tipo_evento`), which stages it.
  Deliveries and dispatches worded `al remitente` are the return leg and stage as returned.
- The location is the facility that scanned, or the branch holding the parcel for collection.
- The receiver's name and RUT, route notes, observations, the sender's references and the
  masked delivery address are dropped. The service, the weight, the dimensions and the
  promised day are kept; the promised day is dropped once delivered or returned.
- Links to the help centre's `/pre-seguimiento/` or `/seguimiento/` page and the old tracker's
  `Resultado-busqueda.aspx?DATA=` links name the number.

## Limitations

- The tracker on www.chilexpress.cl and the help centre's search box send a reCAPTCHA v3 token
  with every search. The old tracker's `DATA=` link no longer opens an order.
- The number of a consolidated transport order, which groups several, answers not found.
- Event types no live reply showed, such as an incident or a parcel awaiting payment, are
  staged by their wording.

## Numbers

Chilexpress tracks a shipment by its transport order number (orden de transporte, OT), which
the help centre checks as ten to twelve digits. Other inputs are invalid without a request.
Bare digit runs of these lengths are printed by many carriers and nothing in the number points
to Chilexpress, so no detection rule claims them and preflight does not ask this adapter. The
samples and their sources are in [`numbers.json`](numbers.json).

## Live test

Set `CHILEXPRESS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/chilexpress/adapter.live.test.ts`.
Optionally set `CHILEXPRESS_UNKNOWN_NUMBER` to check a not-found number.
