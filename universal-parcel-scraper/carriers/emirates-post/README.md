# Emirates Post

Tracks postal S10 items, including inbound mail, and thirteen-digit domestic items through
the official public tracker. An identifier is confirmed only by a matching tracking reply.

## How it works

1. `trawl`: opens the single-item `all-services/track-a-package/step-two?q=` page. The browser
   clears Cloudflare's managed challenge; the page's server-rendered Next.js data carries the
   history. Both the page query and its one result must name the whole requested identifier.

Requires the optional TRAWL service. Recognition through this path is browser-only and opt-in.
Verification and rate limits stay distinct from the page's explicit not-found response. Enabled
universal providers remain available.

## Numbers

Detection names Emirates Post for the parcels, EMS, registered and tracked-letter items it
issues: `C`, `E`, `L` or `R` first, `AE` last and a passing check digit. Its tracker relays the
destination post's events of an item sent abroad, such as import customs and the delivery depot.
Its other `AE` codes stay with the generic postal carrier and are offered for browser
confirmation. Shared domestic digits remain unclaimed without an explicit carrier or tracking
link.

## Notes

The page's order is retained across offices with different clocks. Naive timestamps keep their
wall clock; an explicitly named UAE city also gets a deduced Dubai instant with its place basis.
Foreign and unidentified offices keep local time; the shared dater gives such a scan its
neighbours' zone, else the UAE's. An offset the source states is preserved.
The destination country comes from the wording that ends with where the item is sent ("Shipped
to", "Arrived at"), when it names a country rather than a city.
Sender, receiver, contact details, reference fields and event links are omitted.

The Android app (`ae.emiratespost.retailapp`) has a guest `TrackAwbDetails` route on
`box.emiratespost.ae`. Its configuration requires Firebase App Check before it issues a key;
that install state is not needed for the anonymous browser page. The documented business
tracking API requires customer credentials.

## Testing

Set `FLARESOLVERR_URL`, `EMIRATES_POST_TRACKING_NUMBER` and optionally
`EMIRATES_POST_UNKNOWN_NUMBER`, then run
`npm run test:carriers:live -- carriers/emirates-post`.
