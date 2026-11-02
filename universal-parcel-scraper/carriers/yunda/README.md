# Yunda Express

Tracks Chinese domestic waybills through the official consumer website.

## How it works

A request-scoped anonymous session fetches the verification type and slider images,
then submits one lookup. The adapter matches the transparent piece outline to the
white gap only when the match is strong and unambiguous. Backend acceptance is
required. An uncertain match refreshes the verification type and image once in
the same session, within the original deadline. Changed image layouts stop the lookup.

## Notes

Domestic scan clocks use China time. Provider order is preserved across missing or
invalid clocks, which remain unresolved. Exact scan status labels drive the current
state. Return movement remains active until a sender delivery is confirmed.

Only short status wording and bracketed city locations are retained. Expanded
descriptions, names, phones, addresses, signatures and unlabelled weights are excluded.

## Limitations

Anonymous queries expose a partial history; the website requires login for the full
timeline. Empty replies are inconclusive. International shipments and Yunda freight
use separate flows. Other verification types and a second ambiguous image remain
challenge failures. Backend refusals are not retried.

## Testing

Set `YUNDA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/yunda/adapter.live.test.ts`.
