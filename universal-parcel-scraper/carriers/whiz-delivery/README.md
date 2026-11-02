# Whiz Delivery

Whiz Delivery is a last-mile courier in the Toronto, Vancouver and Montreal areas, founded in
2025. [Stallion Express](../stallion-express/README.md) hands parcels to it. Its site is
whizdelivery.ca.

## How it works

1. `direct`: one `GET https://api.whizdelivery.ca/v1/track-public/{number}`, the public API its
   tracking page reads. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the API or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the API does not know gets HTTP 404 with the detail `Shipment {number} not found`,
  read as not found. A 404 without that detail is a moved route, a redirect is too, a 403 or a
  firewall page in place of the JSON is a challenge, and a 429 is a rate limit.
- The reply must name the whole number asked.
- Recognition makes the same request.

## Notes

- Whiz runs its deliveries on WooDelivery, and each event carries a WooDelivery task status id
  beside Whiz's own wording. The adapter keeps the id as the provider code, and the status map
  stages the ids. Ids the public tracker has not shown yet, such as a failed delivery, a return
  or a cancellation, are staged from WooDelivery's list and the status Whiz's API reference
  names for a missed delivery awaiting another attempt.
- Events are UTC instants. The tracking page reads one without an offset as UTC, and so does
  the adapter.
- The origin and destination towns, the shop, the expected delivery and the delivery photo,
  which the page shows only after the recipient's postal code, are not read.

## Limitations

- No places or expected delivery.
- A shipment Whiz hands to another carrier can name it and a tracking link; no such reply has
  been seen, so neither is read.

## Numbers

Its tracker says numbers start with `SW` or `WHZ`. Archived lookups show `SW` and ten
hexadecimal characters, which `whiz-delivery-1` suggests at low confidence. No `WHZ` number has
been found, so it has no rule.

## Links

The tracker's address carries the number in its path.

## Testing

`npm run test:carriers:live -- carriers/whiz-delivery`, with `WHIZ_DELIVERY_TRACKING_NUMBER` and
optionally `WHIZ_DELIVERY_UNKNOWN_NUMBER` set outside the repository.
