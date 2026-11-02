# Trendyol Express

Reads the domestic shipment timeline from Trendyol Express's public cargo tracker through
the optional TRAWL browser service.

## Retrieval

The `trawl` step opens `kargotakip.trendyol.com/?orderNumber={number}` in the ordinary browser
tiers. Cloudflare guards the page's JSON lookup, so the adapter reads the rendered page.
It waits for the shipment summary or the missing-shipment notice; the initial app loader
is not a tracking result.
The result must repeat the whole requested shipment number in its delivery details. A
not-found notice must also quote that number; an empty form or unresolved browser check is
never a missing shipment.
Despite the URL parameter's name, the shipment must match the page's delivery number,
not its separate marketplace order reference.

The page renders its entire history inside a collapsed section. Expanding it only changes
its height, so no click or custom TRAWL helper is needed. The progress rail contains future
steps and is not used to stage the shipment. Scans use the existing wording map, retain their
wall clocks and read only the town field. No HTTP recognition is offered.

## Limitations

The adapter reads shipment numbers rather than marketplace order references or opaque
tracking keys. It keeps no recipient, address, seller, delivery acknowledgement or action
controls. The page's estimate is not read. Enabled universal providers remain available
when browser verification prevents retrieval.

## Testing

`npm run test:carriers:live -- carriers/trendyol-express`, with `FLARESOLVERR_URL` and
`TRENDYOL_EXPRESS_TRACKING_NUMBER` set outside the repository. An optional
`TRENDYOL_EXPRESS_UNKNOWN_NUMBER` checks the bound not-found notice.
