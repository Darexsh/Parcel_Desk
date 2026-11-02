# Amazon Shipping

Amazon Shipping (SWA) and Multi-Channel Fulfillment (MCF) parcels, tracked anonymously
through Amazon's public tracker. The number formats are shared with the account-only
[`amazon-logistics`](../amazon-logistics/README.md), so this carrier is never picked by
detection or by the user (`selectable: false`). A parcel reaches it only after the host
check proves the tracker knows it.

## How it works

1. `direct`: `GET {origin}/api/tracker/{number}` with the public tracking page as `Referer`
   (15 s timeout, 2 MB cap). The origin comes from the number's prefix
   (`core/catalog/amazon.ts`): `IT`, `ES` and `UK`/`GB` have their own `track.amazon.*`
   host, `TBA`, `TBC` and `TBM` use `.com`, every other European prefix uses `track.amazon.fr`.
   `track.amazon.com` is Amazon's North American tracker. Its page lists only the US, so the
   European tracker's list of sites (GB, IT, IN, FR, ES) leaves it out, and the European hosts
   answer not found for TBA parcels it knows. Canada and Mexico have no tracker host of their own.

Checks, before any history is read:

- A web page in place of the JSON: `ChallengeError` for Amazon's robot check, otherwise
  `IndeterminateError`. The tracker can answer HTTP 200 with its own page shell, which says
  nothing about the parcel; unknown ids get JSON. A reply that is neither is a `SchemaError`.

- `TRACKING_ID_NOT_FOUND` or `INVALID_TRACKING_ID` in `progressTracker.errors`:
  `AmazonShippingNotFoundError`. The tracker answers unknown ids with HTTP 200, not 404.
- `ERROR_INVALID_OFF_AMAZON_ORDER`: not found. The id belongs to an Amazon retail order that
  only the buyer's account can track, so the parcel stays with `amazon-logistics`.
- A tracking id echoed anywhere in the payload that differs from the request: `SchemaError`.
- `trackerSource` other than `SWA` or `MCF`: not found. A generic page proves nothing.
- Only `SHIPMENT_OLDER_THAN_SUPPORTED_AGE`: `AmazonShippingHistoryExpiredError`. The shipment
  exists but its history is gone; the `IN_TRANSIT` summary that comes with it is a
  placeholder, not movement. The host stores a history-expired marker and stops syncing.

## Notes

- Promotion from `amazon-logistics` needs a structured `SWA` or `MCF` reply. The check lives
  in the host ([`src/server/amazonShippingEligibility.ts`](https://github.com/plhery/delivery-tracker/blob/main/src/server/amazonShippingEligibility.ts))
  because it uses host observability and `HttpError`s. It runs again when a parcel is created
  or its carrier changes; a client-supplied carrier name is never trusted. Guessing
  optimistically would show an account-only parcel as trackable and then never update it.
- `progressTracker`, `eventHistory` and `addresses` arrive as JSON strings inside the JSON.
  An unparseable one is a `SchemaError`, never an empty success.
- The host narrows on both error classes with `instanceof`, so keep their names.
  `AmazonShippingHistoryExpiredError` extends `IndeterminateError`, not `NotFoundError`: the
  host's `isUnannouncedTrackingError()` treats any 404 as "not announced yet", the opposite
  of what expiry means.
- The tracker gives clocks without an offset in UTC, on every host: it promises US deliveries
  for 3 AM, the evening before in every US zone. The number's prefix gives the `timezone`
  (default `Europe/Paris`) and the day of `expected_delivery`. `TBA`, `TBC` and `TBM` numbers
  identify no zone and have neither, since a promise's day is the recipient's. A clock that
  cannot be read keeps its text.
- `delivered_at` is the newest delivery scan's time. A delivered parcel has no
  `expected_delivery`.
- A scan's wording follows its event code. Out-for-delivery scans carry the string id of the
  delivery centre's arrival, so only in-transit scans take the arrival, sorting and departure
  wording. The final hub, "the final hub/delivery station" on Amazon's tracker, reads
  "Arrived at delivery center". The app identity policy requires the same instant and event
  code before updating a reworded or restaged stored scan. A scan an earlier release read on a
  local clock shows its stored row's wall clock under +00:00 and takes that row over.
- A departure scanned right after the out-for-delivery scan, within the hour and at the same
  station, is the van leaving with the parcel. It keeps the "Departed facility" wording but
  stays out for delivery, so the newest scan does not step back to in transit.
- Dates mix ISO-8601, RFC 2822 and US long form ("Aug 11, 2026, 4:31:56 PM"), so the adapter
  uses its own parser instead of a `core/time` helper.
- `DELAYED` / `LATE` map to `in_transit`: a delay is not an exception. Nor is it movement: a
  delayed parcel whose scans show only its label stays registered, with the delay as its status
  text.
- Events are deduplicated on (clock, location, code, description), sorted newest first and
  capped at 100. Shipment status comes from the summary's `trackingStatus`, `status` and
  tags, else from the newest event that classifies. A summary whose only signal is a
  `status` repeating the newest scan's event code defers to that scan. So does a summary
  saying delivered when no scan does: the tracker said so of parcels that had just left their
  pickup site and were scanned in transit for another day before their delivery scan.
- No universal-provider fallback: Amazon is the only source for these numbers.

## Limitations

- Merchant name, recipient name and contact, the `addresses` block and the proof-of-delivery
  image are never read. From the event `location` only city, region and country are kept; it
  also carries street and postcode.

## Testing

`npm run test:carriers:live -- carriers/amazon-shipping` probes a wrong
number. Set `AMAZON_SHIPPING_LIVE_TRACKING_NUMBER` for a real shipment, plus
`AMAZON_SHIPPING_EXPECT_NOT_FOUND=true` or `AMAZON_SHIPPING_EXPECT_EXPIRED=true` when that
is the expected outcome.
