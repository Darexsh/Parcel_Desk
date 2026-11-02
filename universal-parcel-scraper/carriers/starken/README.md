# Starken

Starken is a Chilean courier with branches across the country. It carries parcels and freight
between its branches and to the door, for people and for online shops. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: two requests to `https://seguimientoof.starken.cl/seguimientoOf/statusOf`, as the
   tracking page makes them, both with `Origen: CL` and the page's `Origin`. Without the origin
   the service refuses the key.
   - `POST /gettoken` with `{"token":"…"}`, the same token as the `Apikey` header. The token is
     `STARKENCL|{clock}|{key}|{number}` sealed as `CryptoJS.AES.encrypt` seals a text under a
     passphrase. The reply's `payload` is a key for that order.
   - `GET /historialClOfs/{number}` with that key as `Apikey`. The reply is the order sealed
     under a second passphrase, sent as text.

- The source name, key and both passphrases are in the tracking page's script, obfuscated, the
  same for every visitor. The adapter carries them.
- The page sends the visitor's wall clock in the token; the service takes any zone's, and the
  adapter sends UTC.
- The service's servers disagree on the time, and one can refuse with 401 a key another has
  just minted. The adapter asks again with the same key, then with one new key twice; a refusal
  after that is indeterminate. A 401 for the token itself means the page's key or seal changed.
- An unknown number is HTTP 404 with `"No se encuentan datos para la of consultada."`. A number
  the service cannot read is a 404 with `"Orden de flete invalida"`, reported as invalid input.
  A 404 without such a body is a moved route.
- The opened order must name the number asked, both as the order consulted and as the order
  found.

## Notes

- Scan clocks are `DD-MM-YYYY HH:mm:ss` wall clocks without a zone. Chile's regions do not keep
  one time all year, Magallanes stays on summer time, and the reply does not say where a branch
  is, so the clocks stay `local_time`.
- A scan's wording is its `estado_interno`, as the page shows it, in Spanish. Its `macro_estado`,
  the step of the page's progress rail, is the provider code and stages it. A failed delivery
  attempt and a parcel ready to collect sit under other steps, so their wording stages them.
- An order with several packages lists each package's scans. They are merged, and a scan both
  packages share is kept once.
- While a parcel waits, the system adds "El envío sigue en proceso anterior" every few days.
  It has no stage, and a run of them keeps its newest.
- An order Starken closed without a delivery is an exception, with the closing type, such as
  `EXTRAVIADO`, as its provider code, or `RECLAMO` when the page names the closure by its claim.
  A delivery or a return stands over a closure.
- The estimate is the date part of `fechaEntEstimada`, as the page shows it, until the order
  ends or closes.
- The reply carries the sender's and recipient's masked names, RUT, phone, email and address,
  the payment, the declared value, the proof of delivery and coordinates. None are kept.
- There is no recognition. Starken numbers its orders in sequence, so nearly any nine digits in
  its current range are some order of its, and a known answer would not tell a Starken parcel
  from another carrier's number.

## Limitations

- No weight, no service name and no delivery time as an instant. A scan's place is only the
  branch its wording names.
- Customs steps of international orders come without clocks and are not kept.

## Numbers

Starken tracks a shipment by its order of freight number (orden de flete, OF), nine digits in
the tracking field's example and in public lookups; the page takes up to nine digits. Nine bare
digits are printed by many carriers and nothing in the number points to Starken, so no rule
claims them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Starken's own pages send a shipment to `starken.cl/seguimiento?codigo=` followed by the number,
which opens it. The older site used `starken.cl/seguimiento/` followed by the number.

## Testing

`npm run test:carriers:live -- carriers/starken`, with `STARKEN_TRACKING_NUMBER` and optionally
`STARKEN_UNKNOWN_NUMBER` set outside the repository.
