# Correo Uruguayo

Tracks Correo Uruguayo items, its own and the S10 items other posts send to Uruguay, through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://ahiva.correo.com.uy/servicioConsultaTntIps-ws/seguimientoEnvios/eventosweb?codigoPieza={number}`,
   as the tracking page sends it. It needs no account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The reply is an array with one entry per code. Its `estado` is `SUCCESS` with the scans newest
  first, `NOT_FOUND`, `FILED` for an item whose records went to the archive, or
  `INVALID_PRODUCT` for a code ending UY with service letters the post does not use. Those are
  found, not found, expired history and invalid input. A 403 or a firewall page is a challenge. A
  404 or a redirect is a moved route.
- The entry must name the whole requested code, as `idNacional`, `idInternacional` or both. A
  not-found entry for another post's code names none; the reply then answers the one code sent.
- Recognition makes the same request.

## Notes

- The page reads several codes from its address, separated by commas, and asks for them in one
  request with semicolons between them. The adapter sends only the code asked.
- The tracker pads a code with too few digits and looks that one up. The adapter sends only
  whole S10 codes with a valid check digit and checks the code the entry names.
- The history joins the post's own offices' scans with those of the international exchange,
  which also relays the sending or receiving post's scans. A scan's `fecha` is a wall clock to
  the minute with no zone, and a relayed scan keeps the other country's clock, so the clocks
  stay `local_time`.
- The two systems number their scans apart: one code can carry two wordings, and one wording
  two codes. The wording sets the stage, unknown wording goes to the shared rules, and the code
  is kept. A delivery both report in the same minute is kept once.
- The adapter keeps each scan's wording up to its first colon. Delivery and attempt wordings,
  `ENTREGADO A:` and `INTENTO DE ENTREGA:`, go on with recipient details, which are not kept; the
  delivery reads `ENTREGADO`.
- The entry's `codigoEtapaEntrega` is the step of the page's progress bar. Its delivered step
  marks the item delivered when the scans do not; the other steps stage an item only when no
  scan does.
- An item with two codes, the one it came with and the one the post gave it, reports the other
  as `international_tracking_number` or `canonical_tracking_number`.
- The scan's office code, source, operator, round and delivery note, and the entry's notice,
  are not kept.

## Limitations

- The tracker has no ETA, weight, service, origin, destination, recipient or delivery instant
  with a zone.
- Older items go to the archive; the tracker then shows only the day of the last scan, and the
  adapter reports the history as expired.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Correo Uruguayo's tracker asks for the full thirteen-character code: two letters, nine digits
and two letters, the UPU S10 layout. Domestic items carry it too and end in UY, as archived
lookups show; inbound items keep the origin post's number, and the post assigns a new one
when an inbound purchase arrives without a valid code. Generic postal detection keeps the
layout, and a code ending `UY` only suggests Correo Uruguayo, which recognition asks first.
Mail from abroad reaches Correo Uruguayo when a caller names it, a provider names it, or a
result gives Uruguay as the destination of an S10 item. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page reads `codigoPieza` and looks the item up at once, so
`ahiva.correo.com.uy/servicioConsultaTntIps-web/SeguimientoJSNuevo?codigoPieza={number}` opens
one item. Several codes can be given, separated by commas. The page on `correo.com.uy` embeds
it.

## Testing

`npm run test:carriers:live -- carriers/correo-uruguayo`, with `CORREO_URUGUAYO_TRACKING_NUMBER`
set outside the repository. Optionally set `CORREO_URUGUAYO_FILED_NUMBER` to an archived item
and `CORREO_URUGUAYO_UNKNOWN_NUMBER` to a code the tracker does not know.
