# Guatex

Guatex is a Guatemalan courier with agencies across the country. Tracked through the lookup its
tracking page makes for a visitor.

## How it works

1. `direct`: one `POST https://servicios.guatex.gt/Guatex/Login/ObtengoTrackingGuia` with the
   form field `noguia`, the request the tracker page at `servicios.guatex.gt/Guatex/RastreoTracking`
   sends. It needs no cookie, token or account. The JSON reply holds a code, a summary of the guía
   and its rows, newest first, each with a day, a clock, a wording and a one- or two-letter code.
2. `retry`: one more try after a request that fails to reach Guatex or hangs, inside the budget.
   The first try gets half of the budget.

- An unknown guía is HTTP 200 with code 204, "El número de guía no existe", which is not found.
  The page reads any code other than 200 as a missing guía; the adapter reads any other code or
  answer as inconclusive. A page in place of the reply, even with HTTP 200, is a challenge, and a
  404 or a redirect is a moved route.
- Both answers name the guía at the top, and a found one again in its summary and every row. Each
  must be the whole guía asked.
- Recognition makes the same request.

## Notes

- Rows are staged by their code, as the page's script names them. `G`, the departure from an
  agency, has no name there and is in transit.
- `E`, a departure from a warehouse, takes parcels between warehouses as well as out on the
  delivery route. It is out for delivery when the courier's delivery or a failed attempt follows
  it, and in transit otherwise.
- The courier's delivery (`T`, Entrega Móvil) is the handover: the summary's delivery time is its
  clock. An agency delivery (`N`, Entregado en Agencia) seen hours after it is the same delivery
  recorded at the agency. Both are delivered, as the page shows them, and `delivered_at` is the
  summary's delivery time, else the courier's delivery.
- A row whose wording names a return ("Devoluci…"), which the page reads the same way, is the
  return: delivered back to the sender, or under way. A failed attempt's wording is its reason.
- A guía of several pieces comes back as one history under its own number.
- A summary whose status is `ENTREGADO` stands for a delivery the rows lack, unless they hold a
  return.
- Guatemala keeps UTC-6 all year, so a row's day and clock, to the minute, are read there as an
  instant. A row without a clock keeps its day.
- The page leaves out rows with code `S`, the cash-on-delivery amount credited to the sender, and
  so does the adapter. Each row also names a route, which the page does not show. It names the
  route the parcel left or arrived on rather than where the scan happened, so it is not read.
- Only the number, the rows' days, clocks, wordings and codes, and the summary's status and
  delivery time are kept; the reply's other details are not.

## Limitations

- No locations, expected delivery, weight or service name.

## Numbers

Guatex guías seen in public have eleven characters: a letter, three or four digits, one or two
letters and five digits. An integrator's guide shows two in a sample Guatex reply, each with
child guías for further pieces, and a customer quoted one on Guatex's Facebook page. Three
samples in two variants are too few for a rule, so no rule claims them. The tracker's field
takes up to fifteen letters and digits, and so does the adapter. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

Guatex's site opens its tracker at `servicios.guatex.gt/Guatex/RastreoTracking` with `tipo=G`
and the guía in `dato`, and the page looks the guía up on load. The tracker page also takes a
guía typed into its own field.

## Testing

`npm run test:carriers:live -- carriers/guatex`, with `GUATEX_TRACKING_NUMBER` and optionally
`GUATEX_UNKNOWN_NUMBER` set outside the repository.
