# FedEx Freight

Tracks FedEx Freight, the less-than-truckload carrier serving the United States, Canada and
Mexico, through the lookup its Detailed Tracking page makes.

## How it works

1. `direct`: one `POST https://api.ltl.tech/fxf-external-tracking-auth4/fxfgw/route/track/v2/track-shipments`,
   the gateway the page asks for a visitor who is not signed in. The body is the page's:
   `{"appDeviceType":"WTRK","appType":"WTRK","summaryView":false,"supportHTML":true,"supportCurrentLocation":true,"trackingInfo":[{"trackNumberInfo":{"trackingCarrier":"","trackingNumber":"{number}","trackingQualifier":""}}],"uniqueKey":"","guestAuthenticationToken":""}`,
   with its `X-client-id: FDXFWEB`, `X-locale: en_US` and `X-version: 1.0.0` headers. It needs
   no cookie, token, key or browser. The JSON reply lists the packages found for the number in
   FedEx's track model, each with its summary and its scans, newest first.
2. `retry`: a request that fails to reach the gateway, or hangs, is sent once more within the
   budget.

- A package flagged `notFound` without a qualifier is a missing shipment, as the page reads it;
  flagged `invalid`, a number FedEx Freight does not take. When the package carries an
  authorization error, the page asks the visitor to sign in, and the adapter reports that input
  is required.
- An empty `packages` list is inconclusive: the page reads it as no result, but the gateway gives
  the same answer to a value it refuses outright.
- The gateway answers a request it cannot read with HTTP 400 and `{"status":null,"data":null}`.
  The request is the page's, so that reply means the service changed. Akamai fronts the gateway;
  a block page, a 403 or a rate limit keeps its own failure kind.
- The package must echo the whole PRO number and carry FedEx Freight's carrier code, `FXFR` or
  `FDFR`. The page's search also finds other FedEx services, such as FedEx Custom Critical; their
  history is not relayed. Several packages for the number, which the page asks the visitor to
  choose between, are inconclusive.

## Numbers

FedEx Freight tracks freight by its ten-digit PRO number; anything else is invalid without a
request. Spaces, dots and dashes are dropped. Ten digits are shared by many carriers and nothing
in the number points to FedEx Freight, so no rule claims them; a caller names the carrier or
pastes a tracking page link. The digit runs the tracking page prints as input examples are not
recorded. Handling-unit labels carry their own parcel-style tracking numbers, which stay with the
FedEx entry.

## Notes

- A scan's `date`, `time` and `gmtOffset` give an instant. Every scan carries `-05:00` whatever
  the terminal's zone, and the page converts each one by that offset, so the adapter keeps it as
  given. A scan without an offset keeps `local_time`.
- A scan's description is its status, then its details, such as
  `Shipment exception: Weather – Delay in transit`; the delivery keeps its status alone. Its
  `statusCD` stages it, as mapped in [status.ts](status.ts). An arrival with the exception code
  `DARV` is the driver at the consignee's site, so it counts as out for delivery.
- `delivered_at` is the delivery scan's instant. The weight is the shipment's total in pounds,
  given in kilograms. The estimate is the day of `estDeliveryDt` and is dropped once the freight
  is delivered. The service and the destination's country come from the summary. With no scan
  yet, the answer is the summary's status alone.
- The reply also names the shipper and consignee with their towns, the receiver and the person
  who signed, references, bills of lading and the driver, and carries coordinates. None of them
  is read.

## Limitations

Recognition is not offered: the gateway's not-found answer for a ten-digit PRO is known only from
the page's code.

## Links

`fedexfreight.com/fedextrack/?trknbr={number}` opens one shipment: the site's tracking
settings point there and archived lookups use it. The library reads the number from `trknbr`.

## Live test

Set `FEDEX_FREIGHT_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/fedex-freight/adapter.live.test.ts`.
Optionally set `FEDEX_FREIGHT_UNKNOWN_NUMBER` to check that a PRO number FedEx Freight does not
know is never read as a shipment.
