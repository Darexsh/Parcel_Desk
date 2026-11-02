# TDN

TDN is a Spanish road network for industrial and commercial parcels, serving mainland Spain,
the islands, Ceuta, Melilla and Portugal. Kuehne+Nagel owns it; TDN keeps its own brand and
tracker, separate from the Kuehne+Nagel entry. Tracked through the tracker its tracking page
sends a number to.

## How it works

1. `direct`: one
   `GET http://tracking.tdnonline.com/consulta_expediciones/tracking?REFERENCIA={number}&Aceptar=Aceptar`,
   the address the tracking page on tdn.es opens. It needs no cookie, token or browser. The page
   repeats the reference in a heading over a progress rail, whose current slot holds the
   status, the branch's number, sometimes followed by its name, and the time.
2. `retry`: one more try when the request fails to reach the tracker or hangs. The first try
   gets half of the budget.

- An expedition the tracker has not registered gets its notice `Envío no registrado` in the
  rail's first slot, which is not found. A 404 or a redirect is a moved route, and a 403 or a
  bot check is a challenge.
- The heading must name the number asked: another reference is inconclusive.
- Recognition makes the same request.

## Notes

- The tracker answers on plain HTTP only, in windows-1252, which its header names and its
  page calls UTF-8. The adapter follows the header.
- The heading repeats the reference as it was sent, not the shipment's own number, so the
  adapter sends only whole expedition numbers.
- The status's time is a wall clock to the minute, with no zone. TDN delivers in the Canary
  Islands and Portugal, an hour behind Madrid, so the clock stays `local_time`.
- The wording sets the stage; the map is in [status.ts](status.ts). The rail's position and
  the branch are not kept: the wording carries the status, and the page does not say whether
  the branch is where the parcel is, where it left from or where it is going.

## Limitations

- Only the current status: no history, place, ETA, weight, recipient or proof of delivery.
- Older expeditions drop out of the tracker, which then gives its not-registered notice.

## Numbers

Expedition numbers are twelve digits starting with 9999. TDN's tracking page gives that layout
as its example, and archived lookups on its tracker show it. Other carriers' twelve-digit
numbers also start with 9999, so no rule claims them. The adapter takes that layout and
refuses anything else without a request.

## Links

The tracking page on tdn.es reads an `envio` parameter and, with `autoredir=1`, forwards it to
the tracker at `tracking.tdnonline.com/consulta_expediciones/tracking`, which reads
`REFERENCIA`. Both addresses open one parcel.

## Testing

`npm run test:carriers:live -- carriers/tdn`, with `TDN_TRACKING_NUMBER` and optionally
`TDN_UNKNOWN_NUMBER` set outside the repository.
