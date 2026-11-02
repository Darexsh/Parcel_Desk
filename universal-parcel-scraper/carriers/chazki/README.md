# Chazki

Chazki is a last-mile e-commerce courier in Peru, Argentina, Chile, Colombia and Mexico. Tracked
through the GraphQL service behind the tracking page its help centre opens.

## How it works

The help centre at `www.chazki.com/centro-de-ayuda` opens a code at
`nintendo.chazki.com/trackcodeTracking/` followed by the code. That page is a single-page app
that asks `POST https://backend.chazki.com/` two GraphQL queries, and so does the adapter:

1. `getOrderPublicTrackCode` with the code lists the orders filed under it, one per sender that
   used it.
2. `getOrderPublic` with that order's id returns the order.

No account, cookie, key, CAPTCHA or browser is needed. Redirects are not followed. A request that
fails to reach Chazki is sent once more within the budget.

- An empty list is the page's "No se encontró información sobre la orden", read as not found.
- Only an entry and an order naming the whole code count. When several senders' orders share the
  code, the page asks the visitor to choose the sender, so the lookup is inconclusive.
- The service answers a query it no longer accepts with HTTP 400 and the reason, which is a
  changed reply. Its own failures come as HTTP 200 with errors and are inconclusive.

## Notes

- The page's order query also returns the sender's and recipient's names, phones, IDs and
  addresses, the map points, the driver and the delivery evidence. The adapter asks only for the
  order's id, code, service, current status and history.
- The history is a list of status ids and clocks in no order. The page names some of them on a
  five-step rail, and the adapter keeps those with the page's wording, newest first, and leaves the
  rest out as the page does. The rail shows the trip to the sender's `157` only for an order
  without a `156`, and so does the adapter.
- The order's current status decides the stage, as on the rail. Collecting from the sender is not
  yet Chazki holding the parcel, so it stays registered.
- Clocks are day-first, twelve-hour wall clocks to the minute, such as `14/05/2026 2:58 pm`. The
  reply names no zone and Chazki works in several, so they stay `local_time`.
- Detection does not offer Chazki, since senders choose the trackcodes and no shape belongs to it
  alone, so no recognition is declared: Chazki tracking runs when the caller names the carrier.
- The adapter sends the code in capitals, as the package normalizes it.

## Limitations

- The help centre also sends some orders to a Paquery tracker, which needs a reCAPTCHA token
  for every lookup. Orders followed only there are not found.
- No scan locations, estimate, weight or delivery instant.

## Numbers

Trackcodes vary by sender: some are digit runs, others three letters and digits. The samples and
their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/chazki`, with `CHAZKI_TRACKING_NUMBER` and optionally
`CHAZKI_UNKNOWN_NUMBER` set outside the repository.
