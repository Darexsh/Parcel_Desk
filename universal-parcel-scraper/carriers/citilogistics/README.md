# Citilogistics

The native adapter reads Citilogistics consignment histories from its
[guest tracker](https://tracking.citilogistics.ca/). Canada Post delivers the last
mile under a separate number; partner-number lookup needs a verified relationship
and remains with enabled universal providers.

The adapter opens the search form, keeps its guest cookie and submits the current
hidden form value with one complete code. The response must echo that code and
contain one history table. The form value stays within the lookup; it is not a
shareable shipment link. Ambiguous numeric formats have no HTTP ownership probe.

Each row states its own time zone. The adapter preserves its local clock and
uses that stated zone to derive an instant. The heading's lookup time is not a
scan. The combined invalid-number-or-unavailable notice leaves the result
inconclusive because expired records receive the same message.

Live checks use `CITILOGISTICS_TRACKING_NUMBER` and
`CITILOGISTICS_UNKNOWN_NUMBER`:

```sh
npm run test:carriers:live -- carriers/citilogistics/adapter.live.test.ts
```
