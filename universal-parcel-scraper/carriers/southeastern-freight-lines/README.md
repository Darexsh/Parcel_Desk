# Southeastern Freight Lines

Southeastern Freight Lines (SEFL) is a less-than-truckload carrier in the southern and
southeastern United States. It moves palletized freight between its service centers and
delivers it, often by appointment, and hands freight for other regions to partner carriers.
Tracked through the Web Connect tracing service behind its tracer's live tracing links.

## How it works

1. `direct`: `GET https://www.sefl.com/webconnect/tracing?Type=PN&RefNum1={pro}&output=XML`
   returns the shipment and its scans, oldest first. It needs no key, account or browser.
   Without a MySEFL login the reply is condensed: no names, street addresses, references or
   billing.
2. `retry`: one more request after a network failure or a timeout.

- An unknown PRO gets HTTP 200 with an `error` naming it. Only that answer is not found; an
  error naming another PRO, or other text, is inconclusive, and so is a shipment for another PRO.
- The JSON form of the same service answers an unknown PRO with an empty list, so the adapter
  reads the XML form.
- Cloudflare sits in front of the site. A browser check in place of the reply is a challenge,
  with HTTP 200 or 403. A redirect or a 404 is a moved service.
- Recognition makes the same request.

## Notes

- Each scan carries its date, its twelve-hour time and the UTC offset of its service center's
  zone, daylight saving included, so scans are instants. A scan without an offset keeps its wall
  clock. A scan's location is the service center's city and state.
- The wording stages a scan first, then its code. The codes do not tell a pickup from an
  arrival: replies give `LOD`, loaded on trailer, to both, and `SPU`, which the documentation
  calls scheduled for pickup, to the pickup itself. `VOD`, a voided record, is left unstaged.
- "Delivered to Customer" in the shipment's location decides a delivery. Otherwise the newest
  scan with a stage decides, since the location stays "At destination" through the delivery run.
- The signer's name after "Delivered - Signed By:" is left out.
- The estimate is the appointment's day when the status names one, else the committed day. It
  is dropped once the freight is delivered, or when it falls before the newest scan's day.
- The weight in pounds becomes kilograms.
- The shipper's and consignee's towns and ZIP codes, the piece count, the delay reason, the
  appointment's hours, the service centers' phones and the interline fields are not read.

## Limitations

- Freight handed to an interline partner is not followed to it.
- SEFL drops the history of old shipments; their PROs then read as not found.
- No proof of delivery: the documents need a MySEFL login.

## Numbers

SEFL tracks shipments by PRO number. Its tracing page asks for seven or nine digits, without
the terminal code or dash, and the service keeps a leading zero as typed. The adapter takes
seven or nine digits. Both lengths are shared by many carriers, so no rule claims them. The
tracer also searches by bill of lading, purchase order, pickup and quote numbers, which are not
tracking numbers. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

SEFL's tracker prints a live tracing link that reads a PRO number from `?RefNum1=` on
`sefl.com/webconnect/tracing`, with `Type=PN`.

## Testing

`npm run test:carriers:live -- carriers/southeastern-freight-lines`, with
`SOUTHEASTERN_FREIGHT_LINES_TRACKING_NUMBER` and optionally
`SOUTHEASTERN_FREIGHT_LINES_UNKNOWN_NUMBER` set outside the repository.
