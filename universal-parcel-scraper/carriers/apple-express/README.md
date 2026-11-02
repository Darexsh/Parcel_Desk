# Apple Express

Apple Express is a courier founded in 1985 in the Toronto area that runs same-day, last-mile
and residential parcel delivery across Canada and in parts of the United States. SprintStar
was its residential parcel brand, and SprintStar's old tracker now points to Apple Express.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: for an order number, one
   `GET https://trackapi.appleexpress.com/api/track/order/{number}/language/en`, as the tracker
   at `track.appleexpress.com/orderNumber/{number}` makes it. It needs no cookie, token, key or
   browser. The JSON reply has the order's summary and its status rows, newest first. For a
   reference, the adapter first asks
   `GET https://trackapi.appleexpress.com/api/track/trackmultiple/{reference}/language/en`, as
   the page's search does. That list must name exactly one order under the whole reference; the
   adapter then opens that order by its number and returns the number as
   `canonical_tracking_number`.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with `orderDetails`, `statusDetails` and `screenDetails` all
  null, which the page reports as not found. An empty order list is a reference it does not
  know. A 404 or a redirect is a moved route.
- The order's own number, and for a reference its reference, must be the one asked. A list that
  names several orders under one reference, or none under the whole reference, is inconclusive.
- The service counts the lookups of each address, and refuses more than 25 an hour with HTTP 429
  and `Retry-After`, which the adapter reports as rate limited with that delay.
- Imperva stands in front of the tracking page. Its block page in place of a reply is a
  challenge.
- Recognition makes the same requests.

## Notes

- Each row's `generatedAt` is a wall clock without an offset, sometimes with a fraction of a
  second, which is dropped. Within one history some rows are kept in the depot's zone and
  others in head-office Eastern time, so a row's clock stays `local_time`. A row that names its
  zone in `generatedAtTimeZone`, `ET` or `PT`, is read in Toronto's or Vancouver's zone.
- The page lists the rows in the reply's order, and so does the adapter: a depot's arrival can
  read later than its next scan.
- Rows that record a message or a request, such as `Pending Delivery Notification Sent` or
  `Delivery Instructions Added`, move nothing. They keep the stage of the scan before them,
  marked as not evidence of it.
- The order's state number stages a cancelled, lost or returned order, which the page shows
  instead of its history. Otherwise its current status does, else the newest scan.
- `statusChangeText` gives the estimated delivery day, until the parcel is delivered. Its
  delivery time names no zone and is not kept.
- A row's place is a depot's town and province. A place with a digit, which could be a street
  address or a postcode, is not kept. The pickup and delivery towns, the shipper's reference, a
  driver's override text, the delivery instructions and time options, the cancellation's name
  and reason and the support contacts are not kept.

## Limitations

- No weight, service, recipient or shipper.
- The proof of delivery opens only after the shipper's account number and the delivery postcode
  are entered. The adapter does not ask for it.
- A parcel redirected to a pickup point has its point in the reply, which the adapter does not
  read.
- Older orders are purged from the tracker and come back as not found.
- An order number reaches the adapter when it is filed under Apple Express or opened from an
  Apple Express link: no rule claims eight digits, so preflight does not ask it.

## Numbers

Apple Express order numbers are a sequence of eight digits, a run many carriers share, so no
rule claims them; the adapter also takes nine for when the sequence passes eight. The tracker
also opens a parcel from a shipper's reference: `APPL` followed by thirteen digits, which
`apple-express-1` claims, or Cainiao's `CACAINIAO` and eleven digits for marketplace parcels,
which AliExpress detection keeps. The adapter accepts those two references only. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens `track.appleexpress.com/orderNumber/{number}`, optionally after a language
segment such as `en-CA`, and `/reference/{reference}` for a shipper's reference. The older
`goapple.appleexpress.com` pages and SprintStar's tracker carried the order number in
`OrderNo`; the library reads the number from all of them.

## Testing

`npm run test:carriers:live -- carriers/apple-express`, with `APPLE_EXPRESS_TRACKING_NUMBER`
and optionally `APPLE_EXPRESS_REFERENCE`, `APPLE_EXPRESS_CAINIAO_REFERENCE` and
`APPLE_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
