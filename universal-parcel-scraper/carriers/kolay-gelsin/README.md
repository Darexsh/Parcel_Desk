# Kolay Gelsin

The native adapter reads public milestones from the combined Kolay Gelsin and Sendeo guest
tracker. Tracking numbers overlap other Turkish carriers; no number rule assigns ownership.

## Retrieval

TRAWL opens the form with the whole number, completes Turnstile, and submits the public
`/api/shipment/check` request. The reply must confirm both the number and its tracking network.
The result page opens in another browser context using only fresh carrier-domain cookies
whose paths match that page. Its query and shipment object must agree with the verified number.

The public milestones are condensed history and are marked partial, so enabled providers can
supply a fuller timeline. Only reached, dated milestones become events. Local clocks retain
their wall time; matching registration and delivery summaries can provide a stated offset and
more precise time. Personal, courier, address and capability fields are discarded.

## Limitations

TRAWL is required. HTTP recognition never invokes this flow. Verification refusals, including
HTTP 399, do not prove that a parcel is missing. Recipient verification, return journeys and
ambiguous related shipments remain inconclusive. The separate legacy history-verification
route is outside this guest flow.

## Testing

Use private inputs outside Git:

```sh
FLARESOLVERR_URL=… KOLAY_GELSIN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/kolay-gelsin
```
