# SPX Express Philippines

Tracks Philippine SPX Express and Shopee Express single-parcel IDs, including the older `SPEPH` numbers. Other SPX countries have their own portals and are outside this adapter's scope.

The `direct` step reads the public Philippine order endpoint. After an inconclusive reply, `legacy` reads the older public feed with the timestamp checksum used by the current website. Neither request requires account cookies.

Both replies must identify the requested parcel. Marketplace replies identify it in the SLS tracking object; standalone replies also carry order references. Actual visible scans establish progress; hidden records and future progress-rail milestones are ignored. Freight parent orders are inconclusive because one delivered child cannot complete the whole order. Empty replies do not establish parcel absence.

Stages come from the order endpoint's tracking codes and the legacy feed's status names, recorded in `statuses.json`; codes not listed there fall back to the shared wording classifier. Export clearance counts as transit, and a failed pickup leaves the parcel registered with its seller. Scans at SPX hubs, ports and service points keep their place and coordinates. Pickup scans name the seller's own location, which is dropped.

Live test: `SPX_PH_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/spx-ph`.
