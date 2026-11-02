# Central Transport

Central Transport is a US less-than-truckload carrier based in Michigan. Tracked by PRO number
through the lookups its tracking page's script makes.

## How it works

1. `direct`: one `POST https://www.centraltransport.com/webservices/ctservice.asmx/GetTraceLegStatus`
   with the body `{"data":{"type":"1","typeName":"PRO","items":[{"id":0,"number":"{number}"}]}}`,
   the trace the page asks for the PRO numbers typed in, without its form state. The JSON reply
   has the shipment's summary and the tracker's key for it. Then one
   `POST https://www.centraltransport.com/tools/track-shipment.aspx/GetTrackDetails` with
   `{"pro":"{pro}","proNumKey":{key}}`, the page's travel history for that shipment. Neither needs
   a cookie, token, key or browser.
2. `retry`: one more attempt after a failed connection or a timeout. An HTTP status is never
   sent again.

- The tracker answers a PRO it does not know with `ServerResponseFailed` and the message to try
  again later or call customer service, the same answer as for a lookup that failed, so it is
  inconclusive. One unknown number among several fails the whole trace. Recognition is not
  declared for that reason.
- A redirect or a 404 is a moved route; the site sends retired pages to its home page.
- The shipment must name the whole number asked. The tracker writes ten- and eleven-digit PROs
  with dashes, which the comparison drops.

## Notes

- The page shows the travel history only when the summary's `IsTraceDetailsOn` is set, and no
  reply seen sets it, though the history lookup answers. A history that cannot be read, or that
  names another number, leaves the summary alone, marked `summary_only`; a refusal, a rate limit
  or an outage of the history fails the lookup.
- The history lists days newest first and the page orders a day's rows by `RowId`, latest
  first. The delivery has no row: the summary's status, `Delivered.` at its clock, is put above
  the rows when it is newer than all of them, at the summary's current location while the
  freight is on its way. `IsDelivered` settles a delivery.
- Clocks are wall clocks without an offset, which the page says are local, so they stay
  `local_time`. A summary clock is to the minute and a row's to the second.
- A row's stage comes from its wording, then from its service exception flag, which the page
  marks with a warning, then from the shared rules. `Contact Customer Service at (586) 467-1900.`,
  the status of old shipments, moves nothing.
- A row's place is the town and state the history gives it. The weight is the shipment's, in
  pounds. The estimate is the summary's delivery day and is dropped once delivered.
- The reply also carries the shipper's and consignee's names, streets and postcodes, the bill of
  lading, purchase order and reference numbers, handling unit labels and the piece count. None
  of them is read.

## Limitations

- An unknown PRO cannot be told from a failed lookup.
- No delivery time as an instant, no service name and no delivery partner.
- Bills of lading, purchase orders, pickup numbers and handling units, which the page also
  traces, are not looked up.

## Numbers

Central Transport tracks less-than-truckload freight by its PRO number. An archived link to its
own trace page shows a nine-digit PRO, and its document service shows an eleven-digit one
printed with dashes. The site's own formatting puts dashes in ten and eleven digits, so the
adapter takes nine to eleven. These lengths are shared by many carriers, so no rule claims them;
a caller names the carrier. Pickup numbers contain `PU`, and handling-unit labels are not recorded.

## Links

The tracking page sends numbers in a form, so no address opens one shipment. An older trace
page took the PRO in `pro` on `centraltransport.com/confirm/trace.aspx`; the library reads the
number from it.

## Testing

`npm run test:carriers:live -- carriers/central-transport`, with
`CENTRAL_TRANSPORT_TRACKING_NUMBER` and optionally `CENTRAL_TRANSPORT_UNKNOWN_NUMBER` set
outside the repository.
