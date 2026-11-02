# Grupo ampm

Grupo ampm is a Mexican parcel and logistics company that collects and delivers e-commerce and
business shipments across Mexico from its hubs, including AliExpress parcels Cainiao hands over.
Tracked through its tracking page's own lookup.

## How it works

1. `direct`: one `GET https://grupoampm.com/rastreador/?tracking-id={number}`, the address the
   page's form builds. It needs no cookie, token, key or browser. The reply is the HTML page: a
   heading naming the number, then the shipment's promised delivery day, its sender and masked
   recipient, a progress rail, the table of its movements, oldest first, its service and guía,
   and the delivery's details once a run ended.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker has nothing for gets the heading with "Número de guía inválido o sin
  información" (invalid or without information). The tracker never says a shipment does not
  exist, so that answer is inconclusive (`portal_not_found`), not a missing parcel.
- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route.
- The heading must name the whole number asked. The tracker repeats the number as it was typed,
  in any case, and the adapter sends it in upper case.

## Notes

- Movement clocks are wall clocks to the second with no zone, so they stay `local_time`. Each
  names the office that recorded it, which becomes the scan's location.
- A movement's type, such as `AE`, is its `provider_code` and stages it. `EN` closes a delivery
  run and its wording gives the outcome: `DEVUELTO` is a return. Another outcome, such as a
  delivery, falls to the shared wording rules. Once a movement sends the parcel back, every later
  one is part of the return; a destruction stays an exception.
- `DEVOLUCION A CENTRAL` (back to the central hub) is in transit on its own: a parcel that was
  not delivered goes there too.
- The promised delivery day is the estimate until a delivery or a return.
- The sender, the recipient's town (the page shows "Cliente" for the name), the rail, the
  service, the guía, the delivery details (receiver, time, ID) and the link to the proof of
  delivery are not kept.
- No recognition: the tracker's only answer for a number it has nothing for is the
  inconclusive one, and the numbers it takes are shapes other carriers print.

## Limitations

- No instants, weight, pickup point or proof of delivery.
- The delivered wording has not been seen on the tracker.
- The adapter asks one number at a time, although the page takes up to 25.

## Numbers

Grupo ampm's tracker shows guías in more than one layout. A parcel handed over by Cainiao
carried `CNA` and twelve digits, and a standard guía carried `IDTS` and fourteen digits, both
seen in archived lookups; the page also shows a twelve-digit guía for each. Each layout has a
single public sample, too few for a rule, so no rule claims them. The adapter sends ten to
thirty letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker at `grupoampm.com/rastreador/` reads guías from `tracking-id`, up to 25 separated
by commas, as its form and archived lookups show.

## Testing

`npm run test:carriers:live -- carriers/ampm`, with `AMPM_TRACKING_NUMBER` and optionally
`AMPM_UNKNOWN_NUMBER` set outside the repository.
