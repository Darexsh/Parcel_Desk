# ABF Freight

Tracks shipments of ABF Freight, ArcBest's US less-than-truckload carrier, through the service
ArcBest's tracking page asks.

## How it works

ArcBest's tool at `view.arcb.com/nlo/tools/tracking` asks
`GET https://view.arcb.com/api/nlo/track?ref={number}`, without an account, key, cookie or
CAPTCHA token. ArcBest's edge holds a request that does not come from the tracking page, or that
looks automated, for a few seconds and then answers with its own error page, so every request
names the page as its referrer. A request that fails to reach ArcBest is sent once more within
the budget.

The reply holds the number asked, with the shipments found under it. The service also finds a
shipment by a reference such as a bill of lading, so only a shipment whose own PRO is the number
asked counts. An answer only by reference stays inconclusive, as does a U-Pack move, which the
page sends to upack.com. A 404 whose reply holds the number with no shipment is the only missing
shipment; any other 404 is a missing route. The edge's error page counts as a block. Rate limits,
malformed replies and other HTTP errors keep their own failure kinds. Recognition uses the same
lookup.

## Numbers

ABF issues nine-digit PRO numbers. Other carriers issue nine digits too, so detection never
claims one and recognition does not ask ABF; a caller names the carrier or pastes a tracking
page link. PRO numbers are not issued in order: neighbouring numbers can be shipments years apart.

## Notes

- Without an account the reply is a summary: the current status, the progress rail, the pickup
  and delivery dates, the weight and the two ABF service centers. It has no scan history, so the
  result is marked `summary_only`.
- The service labels every clock with Central time's offset, whatever the place keeps; a delivery
  ABF words as Mountain time comes with Central's offset. The offset is dropped. A delivery is on
  the delivering center's clock, which its state and its offset from Central settle, so it
  becomes an instant when exactly one zone fits. No reply shows whose clock a pickup is on, so it
  is an instant only at an origin keeping Central time. A midnight clock is a date the page shows
  without a time.
- The status wording and the rail's titles share one vocabulary, mapped in
  [status.ts](status.ts); wording the map does not know falls back to the shared rules, then to
  the rail's furthest step and the pickup.
- The page shows a projected or appointment day until the delivery; it is kept as the expected
  delivery.
- The status details name who signed for a delivery. They, the parties, appointment contacts,
  references, documents and the service centers' addresses and contacts are never read.

## Limitations

No live reply for a shipment still on its way was seen. ArcBest no longer knows older shipments,
which come back like unknown ones.

## Links

The tool opens a PRO number from its address hash, `view.arcb.com/nlo/tools/tracking#/{number}`,
and moves it to the path. The library reads the number from either form.

## Live test

Set `ABF_FREIGHT_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/abf-freight/adapter.live.test.ts`.
Optionally set `ABF_FREIGHT_UNKNOWN_NUMBER` to check a number ArcBest does not know.
