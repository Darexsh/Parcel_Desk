# Canada Post

Tracks parcel PINs and Canadian postal numbers through the public tracking application's anonymous JSON service. Mail arriving from abroad is tracked under the sending post's postal number. Delivery-notice and numeric reference lookups resolve one parcel PIN before retrieving its history.

Checksum validation prevents malformed postal references from selecting this adapter. A 16-digit PIN ends in a GS1 check digit: one that fails is not suggested, and a valid one stays a suggestion because other carriers share the length.

## How retrieval works

A PIN lookup reads the detail response directly. An alias lookup first requires one exact returned reference and its PIN, then checks the detail response against that PIN. The public application's empty Basic credential is sufficient; no session or browser is required. Both requests share one bounded deadline.

## Decisions and limitations

Scan clocks use their supplied offsets, except on scans relayed from other posts. A scan in another country, or a postal-union exchange scan (codes 4000 to 4600) with no Canadian province, carries -05:00 or -04:00 whatever its place: a Japanese posting labelled -04:00 is the same clock in Tokyo on Japan Post's page, and a Montana delivery office's -05:00 scan is on Mountain time on USPS's (checked 2026-10-10). Such a scan is read on its country's single clock, and otherwise keeps Canada Post's offset, the last guess: hours off, but the reply keeps its instant. Missing offsets retain local clocks, while malformed clocks retain their original labels. Unresolved or guessed rows preserve source order and cannot lend an older timestamp to the current status.

The app identity policy in [app.ts](app.ts) lets a scan read on its country's clock take over the row stored under Canada Post's label, by wall clock, provider code and location. It reads the label as -05:00 (`relabelledFrom: 'Etc/GMT+5'`), the one Canada Post gives such scans in winter and often in summer. A row stored under -04:00 stays apart: only a re-key moves it.

Return flags establish a return journey rather than completed sender delivery. Conditional collection notices keep their pickup meaning. A delivery notice card is a failed attempt. A hold the recipient asked for leaves the item in transit, or ready for pickup when the scan names a post office or pickup point. A customs release moves the item on, whether its code is known or only its wording. Movement remains movement throughout a return journey, and outbound delivery estimates are suppressed.

The delivery estimate is kept while the latest scan is one the adapter knows, including notices that move nothing such as a revised delivery date. The delivery window the tracking page shows becomes `expected_delivery_from` and `expected_delivery`, read on the clock of the province of the newest out-for-delivery scan when that scan's offset agrees with it. Otherwise, and for an end-of-day window, the estimate stays the day. The sender is the business account the tracking page names, and `service_name` the service type it shows, in English.

Delivery time comes from the matching delivery scan. Attempt dates and signature availability cannot substitute for it. A delivered summary without a matching current delivery scan is retained as an undated snapshot.

Empty history, expired history and ambiguous references remain inconclusive. Canada Post gives one no-history reply, code 004, for unknown, not yet scanned and expired parcels; it carries the reason `portal_not_found` so a consumer can tell it from an outage. Other error codes have no reason. Reference results requiring a postcode or containing several parcels are not selected automatically. Output excludes addresses, signatories, signatures, images and service options.

## Live test

Run `npm run test:carriers:live -- carriers/canada-post` with `CANADA_POST_LIVE_TRACKING_NUMBER` supplied outside the repository. `CANADA_POST_LIVE_NOTICE_NUMBER` optionally exercises delivery-notice resolution.
