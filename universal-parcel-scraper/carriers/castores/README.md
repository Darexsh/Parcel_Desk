# Transportes Castores

Transportes Castores is a Mexican freight and parcel carrier with branches across the country.
Tracked by talón through its tracking page, which renders the shipment on the server.

## How it works

1. `direct`: one `GET https://www.castores.com.mx/rastrear.html?guide_numbers={talón}`, the
   address the site's search form opens. It needs no cookie, token, key, CAPTCHA or browser. The
   page shows the talón and service, then the history, newest first.
2. `retry`: one more attempt after a failed connection or a timeout. An HTTP status is never
   sent again.

- A talón the tracker does not know gets the notice "Las guias {talón} ingresados no existe en
  la base de datos.", the only missing shipment. A notice naming another number, a page without
  a notice or a history, a redirect and a 404 are not.
- The shipment must name the whole talón asked. The form takes up to five talones; the adapter
  sends one.
- The form's script first posts the number to `Code/snippets/rest/Api` with
  `action=rastrear`, which answers `success` with an empty shipment for known and unknown
  talones alike, then opens the page. The adapter skips that post.

## Notes

- A history row has a clock, a date with the month abbreviated in Spanish, the heading the page
  files it under, the branch's own status and the branch. The description is the heading, then
  the status when it says something else: `En Ruta de Entrega: TALON RECUPERADO EN OFICINA`.
- The heading gives the stage. Under `En Ruta de Entrega` only the delivery run itself is out for
  delivery; `TALON RECUPERADO EN OFICINA` is the carta porte reaching the destination office
  ahead of the freight, which later rows unload into its warehouse.
- Clocks carry no zone and stay local times. Rows name a branch without its state, branches
  stretch across Mexico's zones, and nothing says whether a clock is the branch's or the
  system's.
- The progress rail over the history repeats what the rows say and is not read. Neither are the
  origin and destination towns, the sender, the recipient or who took the delivery.
- Recognition is not declared: the talón is a bare eleven-digit counter other carriers share,
  though the not-found notice is a clean answer.

## Limitations

- The guía, three letters, a hyphen and digits printed at the top right of the carta porte, is
  not tracked: the page renders nothing for it. Castores' chatbot takes it.
- No estimated delivery, weight, proof of delivery or delivery time as an instant.
- Only home-delivery (`Domicilio`) shipments were seen; a shipment collected at a branch may
  have rows the map does not know, which fall to the shared wording rules.

## Numbers

A carta porte carries two references. The talón is the 11 digits under its barcode, and the
tracking form accepts exactly 11 characters. The guía, printed at the top right, is three
capital letters, a hyphen and five or seven digits. Castores' tracking manual gives an example
of each, and archived lookups on its own tracker show talones with their histories. No rule
claims either: eleven digits are a bare counter other carriers share, and the guía shape has a
single documentation example. A lookup needs the carrier named. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The search form on `castores.com.mx` opens `rastrear.html` with the talón in `?guide_numbers=`.
Archived lookups also show older trackers that took it in `/rastreo/?talon=`, in the
`/rastreo/` path and on `tomcat2.castores.com.mx`.

## Testing

`npm run test:carriers:live -- carriers/castores`, with `CASTORES_TRACKING_NUMBER` and
optionally `CASTORES_UNKNOWN_NUMBER` set outside the repository.
