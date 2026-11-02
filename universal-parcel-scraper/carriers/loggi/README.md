# Loggi

Reads Loggi's public tracking page through the optional TRAWL browser service.

## Retrieval

The browser clears Cloudflare's page check, then Loggi's server includes the shipment in
the page's React component data. The adapter reads those props without running their scripts
and checks both the route and the shipment's whole tracking code. A loaded page or a cleared
challenge alone does not confirm a parcel. Unknown codes render the tracker's missing-page view.

The parser retains scan wording and facility towns. Recipient names, delivery instructions,
documents and verification state stay out of results. The history supplies calendar days,
so scans keep dates without invented times or offsets and retain the page's order within a day.

## Limitations

The eight-character code overlaps other carriers and is only a low-confidence suggestion.
Older merchant references and internal package ids are not supported. No cheap HTTP
recognition is available. Cloudflare can still refuse the browser; enabled universal providers
remain the fallback. A reused code can require the recipient's postcode on the public form;
the adapter does not submit recipient verification.

## Testing

Set `FLARESOLVERR_URL` and `LOGGI_TRACKING_NUMBER`, then run
`npm run test:carriers:live -- carriers/loggi`. `LOGGI_UNKNOWN_NUMBER` also checks an unknown code.
