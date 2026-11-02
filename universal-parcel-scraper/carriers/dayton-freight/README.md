# Dayton Freight

Dayton Freight is a less-than-truckload freight carrier in the US Midwest. It hands freight bound
beyond its network to partner carriers. Tracked through the lookup its tracking search makes.

## How it works

1. `direct`: one `GET https://tools.daytonfreight.com/api/t/byNumber?numbers={PRO}&type=Pro`,
   as the search at `tools.daytonfreight.com/tracking/bynumber` makes it before it opens the
   shipment's page. It needs no cookie, token, key or browser. The JSON reply holds three result
   lists, for freight, expedited and truckload shipments; each result is a shipment's current
   status, pickup, delivery, estimate and partners.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A PRO it does not know is HTTP 200 with every list empty, which the page shows as "No results".
  A result for another PRO is inconclusive. A 404 or a redirect is a moved route.
- The adapter asks by Dayton Freight PRO (`type=Pro`) only; the page's searches by partner PRO,
  and for signed-in customers by shipper, bill of lading and purchase order numbers, are not used.
- The PRO goes as typed. The service reads it as a number, so the eleven-digit barcode form finds
  the same shipment; the result then names the PRO the tracker prints, without the zeros.
- Recognition makes the same request.

## Notes

- Visitors get a summary, not a history: the shipment page's history stays empty without an
  account. The result is marked `summary_only` and holds the current status with its code, town
  and clock, the pickup, and the border crossing and customs clearance when the status has them.
- The page's progress rail reads the status's code: `DLV` and `SAD` are delivered, `PUD` and
  `OFD` out for delivery, `SBR` (skeleton billed) and `PUP` picked up, and the expedited and
  truckload `AVL`, `DSP` and `AS` reach no step. It counts every other code as in transit. The map
  follows it, and for a code the page does not name reads the wording first.
- No clock names its zone; the page says only that its delivery ETA is in the destination
  terminal's local time. Clocks stay wall clocks in `local_time`, so the delivery has no instant
  and there is no `delivered_at`. A midnight clock is a date without a time.
- For freight a partner collected, the page shows the partner's pickup day, and so does the
  result.
- The estimate is the day the page shows until the delivery: the appointment's, else the
  estimated day.
- A shipment handed to A. Duie Pyle, Southeastern Freight Lines or Oak Harbor, partners the reply
  names by their SCAC, names that partner and its PRO. The status then relays the partner's scans.
  Dayton Freight's own expedited and truckload services are not partners.
- The status names who signed for a delivery and the trailer, and its service center comes with
  its address, phone and position; none of them is read. The shipment page adds the weight, piece
  count, references, service centers and delivery ETA window. The adapter does not read it: it
  answers an unknown PRO with a generic error.

## Limitations

- No history, sender, recipient, signature, weight or delivery receipt; documents need an
  account.
- A PRO reaches the adapter when it is filed under Dayton Freight or opened from a Dayton Freight
  link: its lengths are shared by many carriers, so no rule claims them and preflight does not
  ask it.
- Old PROs, such as the former status page's, come back like unknown ones.

## Numbers

Dayton Freight tracks freight by its PRO number. Its electronic PRO page says PROs are issued in
sequence without a check digit, and that their barcode pads them with zeros to eleven digits; its
example is a seven-digit PRO. Lookups archived from its tracker show eight-digit PROs, also
padded to eleven, and the tracker answers ten-digit ones too. The adapter takes seven to ten
digits, padded with zeros to at most eleven. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker opens one shipment at `tools.daytonfreight.com/tracking/detail/{number}`. The
carrier's home page sends its tracking form to the same page with the number in `id`, and its
former status pages took the number in `pro`. The library reads the number from each form.

## Testing

`npm run test:carriers:live -- carriers/dayton-freight`, with `DAYTON_FREIGHT_TRACKING_NUMBER` and
optionally `DAYTON_FREIGHT_UNKNOWN_NUMBER` set outside the repository.
