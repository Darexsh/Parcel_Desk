# toyou

The native adapter reads the public customer history for Asda's British collection and returns
network. Parcel ids overlap other carriers, so native tracking needs an explicit carrier or a
recognized toyou link.

## Retrieval

TRAWL opens the blank tracking page through its browser protection. The server-rendered
`mobify-data` state supplies the guest token that the official client uses. The adapter sends
one whole-id lookup to `/api/external/toyou/web/track/parcel/{number}` through TRAWL's HTTP tier.
An unfinished rendered page does not hide the structured history this read returns.

The reply must identify the whole parcel id. Customer-history rows keep their complete local
calendar clocks without inventing an offset. Undated progress-rail entries are ignored.
Dispatch back to a retailer remains in transit. Order capabilities, personal details and the
guest token stay out of results and error diagnostics.

## Limitations

TRAWL is required; HTTP recognition does not run a browser. Only the
explicit structured no-content error bound to the requested id establishes absence; an empty
success, rejected guest session or unavailable route does not.

## Testing

Use private inputs outside Git:

```sh
FLARESOLVERR_URL=… TOYOU_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/toyou
```
