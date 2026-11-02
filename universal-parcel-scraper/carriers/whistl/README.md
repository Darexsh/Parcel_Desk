# Whistl

Tracks Whistl parcels, and the shipments Whistl's clients book through its Parcelhub platform
for other carriers, through Parcelhub's public tracker.

## How it works

Whistl's site links parcel tracking to its Parcelhub tracker, which also serves
`despatch.whistl.co.uk`. Its form opens a reference at
`https://web.parcelhub.net/Tracking/reference/<reference>`, which renders the shipment on the
server. The adapter reads that page with one GET. No account, cookie, key, CAPTCHA or browser
is needed. A request that fails to reach Parcelhub is sent once more within the budget.

The page's heading is the shipment's reference, followed by the carrier and service, then a
card for each parcel with its tracking number and scans. The tracker finds a shipment by its
reference or by a parcel's tracking number, so the page must name the requested number as one
of them. A shipment of several parcels asked by its reference is inconclusive; each parcel is
tracked by its own number. "Unable to find shipment" is the only missing shipment. Parcelhub
can answer a known shipment with its error page and HTTP 500, which stays inconclusive; block
pages, redirects and other HTTP errors keep their own failure kinds. Recognition uses the same
lookup.

`trackmyitem.whistl.co.uk`, Whistl's older tracker, puts every visitor through a Cloudflare
challenge and is not used.

## Numbers

Whistl publishes no number shape: Parcelhub takes the sender's shipment reference and each
parcel's tracking number, which vary by client, service and carrier. The adapter takes letters
and digits, with at least one digit; anything else is invalid without a request.

`whistl-1` offers Whistl at low confidence for L and seventeen digits, the shape of its own
tracker's archived pages and of a parcel its tracker answered, which no other carrier's numbers
share; the digits carry no check digit, so recognition asks Whistl. Other references are
asked about only when Whistl is chosen or a link names it.

## Notes

Each scan has a status category and a sub category from Parcelhub's published tracking event
list; the map reads the sub category, the same for Whistl's scans and the ones relayed from
another carrier. Notes such as a captured weight or a new final-mile number, the sender's
requests and claim advice move nothing: they read as pending, so a consumer does not stage
them by their wording, and the parcel keeps the stage of the scan before them. A sub category
the list does not have goes to the shared wording rules with the scan's wording.

The description cell prints the scan's wording, its depot when it has one and the signatory.
The adapter keeps the wording and the depot's name and never reads the signatory, the depot's
code, the comments below or the sender's and recipient's references. Scan clocks carry no
offset and are kept as local times: Whistl's are UK times, a relayed carrier's are its own.

When the carrier is not Whistl, the result names it once the catalog can place its name, and
gives that carrier's number when the parcel's tracking number differs from the one asked. A
parcel on Whistl's network asked by its shipment's reference gives the parcel's number as its
own; one handed to a delivery partner abroad gives the final-mile number its record notes.

## Limitations

Parcelhub keeps a shipment for a limited time, after which it answers like an unknown
reference. The page has no estimated delivery date and no weight; the postcode its form
offers only narrows the search and is not sent.

## Links

The link opens the Parcelhub tracker for the reference. Pasted links to it, with or without a
postcode, to `despatch.whistl.co.uk` and to `trackmyitem.whistl.co.uk` are read too.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Live test

Set `WHISTL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/whistl/adapter.live.test.ts`.
Optionally set `WHISTL_UNKNOWN_NUMBER` to check a reference the tracker does not know.
