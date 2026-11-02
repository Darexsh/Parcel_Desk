# Laar Courier

Laar Courier is an Ecuadorian courier that collects and delivers parcels across the country,
including imports from its Miami locker service. Tracked through the API its tracking page
reads.

## How it works

1. `direct`: the reads the page at `fenix.laarcourier.com/Tracking/` makes, in its order, under
   `https://fenix.laarcourier.com/Tracking/api`:
   - `GET /buscar/guia?guia={guía}`, the guía's record and state;
   - `GET /etiqueta/deprati?guia={guía}`, its label, which names the guía and gives its current
     state id;
   - then together `POST /estados` with `{"idEstado":{state},"guia":"{guía}","tipoConsulta":0}`,
     the timeline's steps; `POST /novedades` with `{"guia":"{guía}","tipoConsulta":0}`, the
     problems reported; and `GET /estadosTransito?guia={guía}`, the transit details the page
     asks for when its in-transit step is opened.
2. `retry`: the same reads once more after a request that failed to reach Laar or hung.

- Every request carries the basic credentials and the `API_KEY_LAAR` header the page's script
  sends, the same for every visitor. Without them the API answers HTTP 401 for every guía,
  which the adapter reports as a challenge. No cookie, session or browser is needed.
- An unknown guía is HTTP 200 with an empty `objetoADeserializar` from the first read, which
  the page reports as not found; the adapter stops there. A 404, a 405 or a redirect is a
  moved route.
- The record does not name the guía; the label must, and each transit detail too. The service
  matches the whole guía, in capitals or not, and never a part of it.
- A record, label or timeline the service reports as failed is inconclusive. A transit or
  problem list it fails to read is left out, as the page leaves it out.
- Recognition makes the same requests.

## Notes

- The timeline's `objetoADeserializar` is JSON text inside the JSON reply, and its
  `isSuccess` is false even when it has steps.
- The service's clocks have no zone, and the page shows their digits as they come, so they
  stay `local_time`, to the second.
- A step's id stages it; the transit details use the same ids. Steps not reached yet have no
  date and are left out, and so are voided steps, which the page hides. Problems are staged
  by their wording.
- The created step is dated with the guía's latest assignment to a client, which can come
  after the delivery. Dated after a later step, it is left out.
- The record's state decides a delivery, a return or a voided guía. A guía created and not
  collected yet has its state and no dated step, which comes back as a summary alone.
- A step's location is the regional office that recorded it.
- The record and label hold the sender's and recipient's names, addresses and phone numbers,
  the receiver's name and staff email addresses; none of it is kept. The remarks the courier
  and customer service add to a problem are not kept either.

## Limitations

- No estimate, and no delivery time as an instant.
- The customs notes the page opens for an import, the delivery photos and the map are not read.

## Numbers

The guías seen on Laar's tracker are three letters followed by ten digits. Only one public
guía is known, so the range of letter prefixes is unclear and no rule claims the layout. The
tracker names the person who received that guía, so [`numbers.json`](numbers.json) holds an
invented one in its layout.

## Links

`fenix.laarcourier.com/Tracking/` reads the guía from `?guia=` and writes it back there after a
search. The former tracker read it from `?Guia=` on `Tracking/Guiacompleta.aspx`.

## Testing

`npm run test:carriers:live -- carriers/laar-courier`, with `LAAR_COURIER_TRACKING_NUMBER` and
optionally `LAAR_COURIER_UNKNOWN_NUMBER` set outside the repository.
