# OCA

OCA is one of Argentina's largest parcel carriers. It delivers online orders and business
shipments across the country, to the door or to its branches. Tracked through the tracking
method of its e-Pak web service, which shop integrations call.

## How it works

1. `direct`: one
   `GET https://webservice.oca.com.ar/ePak_tracking/Oep_TrackEPak.asmx/Tracking_Pieza?NroDocumentoCliente=&CUIT=&Pieza={number}`.
   The two account fields must be present and may be empty. It needs no cookie, token, key or
   browser. The XML reply is a .NET dataset with one row per state, oldest first: the parcel's
   number, the state with the branch appended, a reason, the branch and a clock.

- An unknown number is HTTP 200 with an empty dataset. A 404 or a redirect is a moved route.
- A malformed query gets HTTP 500 with a plain-text message, read as inconclusive.
- The service reads only the first nineteen characters of `Pieza`, so every row must name the
  number asked.
- Recognition makes the same request.

## Notes

- OCA's tracker at `oca.com.ar/Seguimiento` asks for a reCAPTCHA before it shows a history. The
  web service answers the same parcels without one.
- Clocks are Argentina's wall clock with milliseconds and no offset. The service's
  `Tracking_Pieza_ConIdEstado` sends the same clocks with `-03:00`, and OCA delivers only in
  Argentina, which has a single zone without daylight saving. The clocks are read in Buenos Aires
  time to the second.
- `Tracking_Pieza_ConIdEstado` also numbers each state, but it leaves out some states the
  plain method lists, so the adapter does not use it.
- A scan's description is OCA's Spanish state without the branch, which becomes the location.
  A reason other than `Sin Motivo` follows in brackets unless the state already names it, as
  `No entregado (Solicitada por el cliente)` does. The state stages the scan.
- `Acuse digitalizado`, the proof of delivery scanned at OCA's plant days later, has no stage, so
  the delivery decides. The delivery time is the first of the delivered scans the history ends
  with.
- A piece number, the parcel's nineteen digits with a dash and a digit, is tracked as its parcel:
  the service tracks parcels.

## Limitations

- No estimate, weight, service or scan code.

## Numbers

OCA parcel numbers are nineteen digits: five digits, four zeros and ten more digits. Lookups
archived from OCA's current tracker, its older parcel and e-Pak pages and the tracking service
behind its search show them. No rule claims them: detection compares numbers with spaces and
hyphens stripped, and nineteen digits are then a plain digit run other carriers print too,
Poczta Polska among them. A piece of a parcel adds a dash and a digit, which stays unclaimed as
well.

## Links

`oca.com.ar/Seguimiento/Paquetes/{number}` opens one parcel; OCA's search and the shipping
emails of merchants link there. It shows a robot check before the history. The older parcel
and e-Pak pages took the number as `numero`, `numero1` or `numberTracking`.

## Testing

`npm run test:carriers:live -- carriers/oca`, with `OCA_TRACKING_NUMBER` and optionally
`OCA_UNKNOWN_NUMBER` set outside the repository.
