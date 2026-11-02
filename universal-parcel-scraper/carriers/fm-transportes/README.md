# FM Transportes

The native adapter reads the Brazilian guest tracker's history through TRAWL.

## Retrieval

The browser opens the blank tracker so the page does not spend its Turnstile response on an
automatic parcel lookup. The adapter exchanges that response at `/api/v1/c`, then posts the
whole tracking code to `/api/v1/get` with the resulting guest session. Both requests use
TRAWL's HTTP tier to share the browser's egress. No account credentials are required.

The returned tracking code must match the request. Scan timestamps keep the API's explicit
UTC offsets and precision; the offsetless forecast contributes its calendar day. Recipient,
address, invoice, order-reference and signatory fields are discarded. Verification values
stay within the lookup and are removed from error diagnostics.

## Limitations

TRAWL is required; HTTP recognition does not run a browser. The adapter accepts one volume,
so a delivered piece cannot complete another unfinished piece. Empty success objects and
no-content replies stay inconclusive rather than proving a missing parcel.

## Testing

Use private inputs outside Git:

```sh
FLARESOLVERR_URL=… FM_TRANSPORTES_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/fm-transportes
```
