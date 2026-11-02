# Inter Rapidísimo

Inter Rapidísimo is a Colombian courier network that carries parcels and documents between its
offices across the country and delivers to the door or holds them at an office for collection.
Tracked through the requests its tracker at `siguetuenvio.interrapidisimo.com` makes.

## How it works

1. `direct`: the tracker's three requests to `gateway.interrapidisimo.com`, with no cookie, key or
   browser:
   - `GET /ConsultaGuiasSTE/api/v1/Guias/ConsultarGuias?NumerosGuias={number}&altchaPayload=`
     searches the guide and answers with a session id (`guid`);
   - `POST /ConsultaGuiasSTE/api/v1/ResultadoConsulta/ConsultarGuias` with
     `{"idConsulta":"{guid}"}` returns the guide's summary;
   - `GET /ServiciosTrackingSTE/api/v1/EstadoTracking/ObtenerEstadoTracking?numeroGuia={number}`,
     with the session id as `Authorization` and the tracker's application number in
     `idaplicacion`, returns its milestones, oldest first.

- The service answers in an envelope with a code. The search's "no results" codes, such as
  HTTP 404 with `STE024` for an unknown guide, are the only answers read as not found. A
  refused number format is a changed request, a 404 without the envelope or a redirect is a
  moved route, and the service's other refusals are inconclusive.
- The summary must name the guide asked.
- The page solves an ALTCHA proof of work before a search when its check is switched on, and
  sends an empty payload while it is off, as the adapter does. A search refused for the check
  (`STE033`), an Akamai block page and HTTP 403 are challenges.
- Recognition makes the same requests.

## Notes

- Milestones are dated `MM/dd/yyyy HH:mm:ss` without an offset. Inter Rapidísimo's network is
  within Colombia, which has one zone without daylight saving, so they are read in Bogotá time.
  Deliveries and rounds fall in the delivery window the reply gives.
- A milestone's description is the tracker's Spanish name, which stages it; the reply has no
  status code. "Esperando tu acción", after a failed attempt or an uncollected wait, is an
  exception.
- Milestones name no place. The reply names the origin and destination warehouses, so the
  warehouse milestones take that warehouse's town and department.
- The estimate is the summary's last day of delivery, dropped once the journey ends or when it
  is older than the newest milestone.
- A guide made ahead of handover (`preenvio`) and without milestones is reported as not started,
  as the page shows it.
- Warehouse addresses, the delivery window, the next milestone, the route map and the summary's
  towns, service and client codes are not kept.

## Limitations

- No weight, service name or status code.
- The sender, recipient, delivery evidence and detailed history are shown only after a code
  sent to the sender or recipient.
- A guide returned to its sender ends at "Devuelto al remitente"; the return travels under a new
  guide, which the adapter does not follow.

## Numbers

Inter Rapidísimo tracks a shipment by its guide number (número de guía), which its home page
tracking field accepts as twelve or thirteen digits. Bare digit runs of these lengths are
printed by many carriers and nothing in the number points to Inter Rapidísimo, so no rule
claims them. The tracker's search takes any run of digits; the adapter takes guides of the
home page's lengths.

## Links

The tracker `siguetuenvio.interrapidisimo.com/` followed by the number opens a shipment. The
former `interrapidisimo.com/sigue-tu-envio/?guia=` and `interrapidisimo.com/ExploradorEnvios/Views/?guia=`
pages and the first tracker on `www3.interrapidisimo.com` with `tbxNumeroGuia` also name the
guide.

## Testing

`npm run test:carriers:live -- carriers/interrapidisimo`, with `INTERRAPIDISIMO_TRACKING_NUMBER`
and optionally `INTERRAPIDISIMO_UNKNOWN_NUMBER` set outside the repository.
