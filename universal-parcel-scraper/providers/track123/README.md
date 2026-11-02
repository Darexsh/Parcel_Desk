# Track123 public tracking

Opt-in fallback for named FedEx shipments. The public FedEx page submits through its own guest verification and polls for history. No paid API, account or stored verification proof is used. Set `providers: ['Track123', ...]` to enable it; other carriers and unnamed discovery never use it.

The browser helper captures the exact query and its polling sequence within one deadline. The final reply must identify FedEx, echo the whole number, and finish querying. Every event must repeat that number. A challenge, unfinished poll or refused guest request remains a failure so the next enabled provider can run.

Event clocks retain their wall time and explicit offset; a conflicting UTC field is rejected. Recipient fields and verification material are removed before the reply leaves the browser. Empty history does not prove the carrier lacks the shipment.

Run the configured facade with a public reference supplied outside source:

```sh
FEDEX_LIVE_NUMBER=... FLARESOLVERR_URL=... node --input-type=module -e '
import { UniversalTracker } from "universal-parcel-scraper/node";
const tracker = new UniversalTracker({ providers: ["Track123"], environment: { env: process.env } });
const result = await tracker.fetch(process.env.FEDEX_LIVE_NUMBER, null, {}, null, "fedex");
console.log({ events: result.events?.length, provider: result.tracking_provider });'
```

The public page may require interactive verification that this helper cannot complete. It does not add challenge retries. Service coverage beyond the validated FedEx formats is intentionally excluded.
