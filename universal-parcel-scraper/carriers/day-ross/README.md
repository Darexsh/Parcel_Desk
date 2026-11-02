# Day & Ross

Tracks shipments in the current order system through the API used by the public tracker.
The public Sitecore origin at `prod-dayross.azurewebsites.net/track-shipments` renders the
tracker and issues a fresh anonymous bearer token. The adapter reads that configuration at
runtime; it stores no token and keeps it out of errors. The main `dayross.com` page has a
Cloudflare challenge, while this public origin serves the same guest configuration over HTTP.

`ManageOrders/TrackOrders` searches the shipment number. Its match must name that whole
number as the shipment number or PRO, and identify exactly one order. The tracker then calls
`ManageOrders/TrackOrderById`: its `probillNumber` parameter takes the internal order ID.
Using the printed PRO there calls the wrong record. The history must confirm both the order
and the requested shipment.

Scan clocks have no offsets and remain local. Vehicle position updates, coordinates,
postcodes, signatures and recipient details are excluded. Driver dispatch alone does not
establish that the freight is out for delivery.

An empty current-system search does not settle an older-system identifier. Those shipments
remain inconclusive and pass to enabled universal providers. The older `ShippingAPI` routes
and their access requirements remain a separate retrieval path.

Set `DAY_ROSS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/day-ross/adapter.live.test.ts`.
