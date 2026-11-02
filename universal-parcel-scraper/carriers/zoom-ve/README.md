# Zoom

The native adapter reads Zoom's Venezuelan guest tracker for a whole guía.

## Retrieval

TRAWL opens the public tracking URL with `nro-guia` and `tipo-consulta=1`. A visible readiness
selector waits for either the completed tracking result or a populated Turnstile response.
The adapter reads a completed callback result first; verification may already have consumed
the token. Otherwise, it uses that unused response for a same-egress HTTP-tier lookup.

An unfinished warm widget can retry once with actual Zoom cookies in a fresh browser context.
Only Zoom-domain cookies are imported. Verification values and capability URLs are removed
from error diagnostics and never returned as tracking links.

Both the title and summary must identify the requested guía. The table's local clocks keep
their wall time; the creation date anchors two-digit years. Recipient text and the separate
handover clock appended to delivery wording are discarded. Future rail milestones do not
establish completed scans.

## Limitations

TRAWL is required. Ten-digit guías overlap other carriers, so tracking uses an explicit carrier
or a recognized Zoom link; no number rule claims them. The exact bound missing-tracking
notice establishes absence. Verification refusals and changed pages remain separate failures.

## Testing

Use private inputs outside Git:

```sh
FLARESOLVERR_URL=… ZOOM_VE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/zoom-ve
```
