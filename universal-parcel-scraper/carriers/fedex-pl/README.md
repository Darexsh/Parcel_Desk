# FedEx Poland

FedEx Poland is FedEx's domestic courier network in Poland, the former Opek that FedEx Express
bought. Its shipments have their own tracker, apart from FedEx's worldwide tracking page that
`fedex` reads: FedEx's Polish domestic tracking page embeds an app from
`fds2tracking.emea.fedex.com`, which asks a tracking service on `poland.fedex.com`. Tracked
through that service.

## How it works

1. `direct`: one `GET https://poland.fedex.com/fds2-tracking/trck-v1/info?trackingKey={number}`,
   as the tracking app sends it. It needs no cookie, token, postcode or browser, nor the gateway
   key the app adds. The JSON reply has the shipment's summary and its scans, newest first.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is an empty HTTP 204, which the page reports as not recognized.
- HTTP 240 is the page's other "not recognized" answer, which sends the visitor to customer
  service rather than back to the sender, so it is inconclusive.
- A number the service does not accept is HTTP 400 with the code `trck-1400`. A 404 or a
  redirect is a moved route.
- The reply's `trackingKey`, the number the page shows as searched, must be the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `eventDate` carries its UTC offset, which the adapter keeps.
- The scan's `eventCode` stages it, such as `WK` for the courier taking the parcel out and `DS`
  for the delivery. Several codes share one wording, as every branch scan reads
  "Przesyłka w oddziale FedEx.". The Polish wording stages a code the map does not know, since
  the shared wording rules read no Polish.
- The shipment's overall `status` settles a delivery the scans do not stage.
- The courier's scan carries the planned delivery window, which the page shows under it. While
  that scan is the newest, the window gives `expected_delivery_from` and `expected_delivery` on
  its day in Polish time.
- Locations are the FedEx branches and hubs that scanned the parcel. The weight is the
  shipment's total.
- The signature, the proof of delivery, which needs the payer's account number, the sender's
  reference, the dispatch and delivery branches, the shipping date, the parcel count and linked
  return shipments are not kept.

## Limitations

- No delivery estimate before the courier's scan, and no service, sender or recipient.
- The service drops old histories, so a number delivered long ago answers as unknown.

## Numbers

Domestic shipments carry thirteen-digit numbers, the only form the domestic tracking app
accepts and the length FedEx's
[Polish help page](https://www.fedex.com/pl-pl/customer-support/faq/fedex-account/identify-service-type.html)
gives its domestic service. Archived lookups on the current and former domestic trackers show
them with scans at Polish branches. They start with 6 and end in a GS1 check digit, and
`fedex-pl-1` suggests FedEx Poland for that layout. Other carriers' thirteen-digit numbers can
share it, so the rule stays low and recognition asks FedEx Poland's tracker, which knows only
its own shipments. The passing check digit puts FedEx Poland first unless the reader's country
is another candidate's home. Most lookups archived on the former and current trackers are in
the `623` series, which no other carrier's sample shares, so `fedex-pl-2` puts FedEx Poland
first for it with a passing check digit, wherever the parcel comes from. FedEx's worldwide
tracking does not take thirteen digits.

## Links

The domestic tracking app opens one shipment at
`#/preview?packages={number}&trackingKey={number}`, on `fds2tracking.emea.fedex.com` or on the
FedEx page that embeds it, `fedex.com/pl-pl/online/domestic-tracking.html`. Archived lookups
on the former tracker use
`poland.fedex.com/domestic-shipping/pub/tracktrace.do?packageId={number}`. All are read for
FedEx Poland. So is a FedEx worldwide tracking link (`fedex.com/fedextrack/?trknbr=`, or
`tracknumbers=`) that holds thirteen digits, since that tracker refuses them.

## Testing

`npm run test:carriers:live -- carriers/fedex-pl`, with `FEDEX_PL_TRACKING_NUMBER` and
optionally `FEDEX_PL_UNKNOWN_NUMBER` set outside the repository.
