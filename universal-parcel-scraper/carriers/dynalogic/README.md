# Dynalogic

Tracks Dynalogic home deliveries in the Netherlands and Belgium through the number-only lookup
of its MyDynalogic tracker.

## How it works

The [tracker](https://track.mydynalogic.eu/track/login) first asks
`https://track.mydynalogic.eu/api/transportorder/partial/ordernumber/<number>` for the order's
status, and the adapter sends that one GET. No account, cookie or browser is needed, but the
service refuses a request without the `X-Requested-With: XMLHttpRequest` header and a referer on
the tracker's host, which its page script sends. The `Locale` header sets the caption's
language; the adapter asks for English. The tracker's `?ordernumber=` link fills the number in
and looks it up the same way.

The reply names the order's scenario (a delivery, one left with a neighbour, a swap, a
collection from the recipient, a trip to the client that booked Dynalogic, or a visit that
names neither) and which of its four steps are done. The provider code is the scenario and the
highest step done, and the caption is the status text. While the driver is on the way, the
reply carries the arrival window the tracker draws, in Amsterdam wall clocks; the adapter keeps
it only then. The answer is a summary without scans. The driver's and recipient's coordinates,
Dynalogic's contact details and the delivery-day sentence are dropped.

The reply counts only when its track & trace number is the whole requested one: the service
also finds an order by the merchant's own order number or its end, and such an answer stays
inconclusive. The not-found notice on HTTP 404 is not found. The notice that the visitor's
address is blocked for some minutes is a rate limit with that wait. Other HTTP errors, HTML
pages and malformed replies keep their own kinds. Recognition uses the same lookup: any order
the service returns is known.

## History behind the postcode

With the delivery postcode, the tracker asks
`https://track.mydynalogic.eu/api/transportorder/full/ordernumber/<number>/zipcode/<postcode>`,
which adds the scan history together with the recipient's name, address and contact details,
the merchant, the order lines and the driver. The adapter does not use it: the number alone
gives the status, and the catalog asks no postcode for Dynalogic. The My Dyna Track & Trace
app is another lead, not yet traced.

## Numbers

A track & trace number is the five-digit id Dynalogic gives the merchant followed by the
merchant's own order number, so its length and letters vary and some carry a dash. The adapter
takes five digits followed by up to forty letters or digits. Nothing else in the number points
to Dynalogic, so no detection rule claims it and preflight does not ask this adapter.

## Limitations

The service matches a number as typed, dashes included, while numbers reach the adapter
without them, so an order whose number has a dash comes back as not found and other sources
are asked. The reply gives the delivery day only in a sentence without its year, so a delivered
order has no delivery time. Scenarios the tracker does not draw, a step it marks as failed in
an ongoing scenario and the visits that name neither a delivery nor a collection stay without
a stage.

## Live test

Set `DYNALOGIC_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dynalogic/adapter.live.test.ts`.
Optionally set `DYNALOGIC_UNKNOWN_NUMBER` to check a not-found number.
