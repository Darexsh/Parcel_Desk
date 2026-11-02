# XPO

Tracks XPO LTL freight in the United States, Canada and Mexico. Plain HTTP reads the
former tracking pages; TRAWL recovers through the current public tracker when that
route is blocked or unavailable.

The HTTP route reads the summary and its history link. A missing US PRO is checked
against the linked Mexico system before returning not-found. HTTP recognition reads
only the summary. Browser recognition is a separate opt-in phase.

The browser observes the current tracking endpoint before opening the page. It scopes
the checkbox solver to the visible reCAPTCHA widget; XPO's own client obtains its guest
session and submits verification. The final response must name the whole PRO in both
the envelope and shipment. Intermediate challenges retain their failure kind.

Both routes combine shipment status with history and remove bookkeeping, duplicate
rows and delivery route details. Party information and document links are discarded.
The former pages supply facility wall clocks without offsets; the current API supplies
UTC epoch instants. Neither route invents a timezone for local clocks.

The former pages also supply weight and estimated delivery. Browser recovery currently
reads status, history and service-center locations. Challenges can still refuse a browser,
and no found Mexico-system shipment has been verified.

Set `XPO_LTL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/xpo-ltl/adapter.live.test.ts`.
Set `FLARESOLVERR_URL` to enable browser recovery. Optionally set
`XPO_LTL_UNKNOWN_NUMBER` to check the former pages' not-found response.
