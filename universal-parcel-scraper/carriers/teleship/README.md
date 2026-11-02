# Teleship

Teleship is a UK delivered-duty-paid shipping service for Shopify and WooCommerce merchants.
Royal Mail carries the first mile to Teleship's hub near Heathrow, line haul runs to Belgium
or by air to the US and other markets, and a local carrier delivers. Tracked through the lookup
its tracking page makes, which shows the whole journey and names that last-mile carrier and its
local number once the parcel reaches the destination country.

## How it works

1. `direct`: one `GET https://api.teleship.com/api/tracking/{number}`, as the tracking page
   sends it. It needs no cookie, token, key or browser. The JSON reply has the shipment's
   status, its scans oldest first and, once one takes over, the last-mile carrier.
2. `retry`: the same request once more when the first does not reach Teleship.

- An unknown number is HTTP 404 with `{"messages":[{"message":"Shipment not found"}]}`. Another
  404 is a moved route.
- The tracker ignores case and matches whole numbers only. The shipment must echo the number
  asked.
- Recognition makes the same request.

## Notes

- Every clock in the reply is an ISO instant in UTC, and the page shows it in the reader's zone,
  so scans keep `time` and the delivery estimate is an instant too.
- The reply's `status` is the page's banner and decides the current stage. Each scan's `type`
  uses the same words and stages it. `in_transit` also covers export and import clearance, which
  the wording rules read as customs. A scan's `code` (`S_102`) is its provider code.
- `delivery_event` is staged as a failed attempt: the page says a delivery attempt has been
  made. A return to the sender is `returned`, a cancelled, failed, terminated or discarded
  shipment and an alert are exceptions.
- The page leaves the line-haul partners' names (Mark 3, SEKO, Pro Carrier) out of a scan's
  place, and so does the adapter. A delivery scan loses who signed for it, and every scan loses
  phone numbers. Teleship's shipment ID and the merchant's order reference are not kept.
- `lastMile` is the hand-off: its number becomes `delivery_tracking_number`, and its carrier
  `delivery_carrier` when the catalog knows the name and the link, if any, is that carrier's.

## Limitations

- No weight, service name or destination country. The estimate is dropped once the journey
  ended.
- On Teleship's DHL service the DHL waybill is the tracking number. It stays with DHL Express,
  and the adapter only takes Teleship's own IDs.

## Numbers

Teleship's own tracking IDs start with `TS`, the origin and destination country codes and
fifteen letters and digits, which is how its home page, its developer documentation and its FAQ
write them. `teleship-ts` suggests the UK ones at low confidence, so recognition confirms them.
The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/teleship`, with `TELESHIP_TRACKING_NUMBER` and
optionally `TELESHIP_UNKNOWN_NUMBER` set outside the repository.
