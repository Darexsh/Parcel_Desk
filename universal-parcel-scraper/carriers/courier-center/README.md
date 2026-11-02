# Courier Center

Courier Center is a Greek courier with its own branches and hubs across the country. It hands
some parcels to ELTA or to BOX NOW's lockers for the last leg, and delivers parcels DHL hands
over in Greece. Tracked through its tracking page's own result page.

## How it works

1. `direct`: one `GET https://www.courier.gr/track/result/?tracknr={number}`, the page the
   tracking form opens. It needs no cookie, token, captcha or browser, and the server-rendered
   page has the shipment's status and its scans, newest first.
2. `retry`: one more read when the first fails to reach Courier Center or hangs, inside the
   budget.

- An unknown number is HTTP 200 with the notice "Δεν βρέθηκε φορτωτική με τον αριθμό
  {number}", which the page reports as not found. A 404 or a redirect is a moved route.
- The tracker also finds a shipment by a partner's number or a reference and shows it under its
  own waybill, so the waybill must be the number asked. A page listing several waybills for one
  number is inconclusive.
- Cloudflare in front of the site answers a burst of lookups with HTTP 429 and a `Retry-After`,
  reported as rate limited. Its browser check and block page are challenges. Every page of the
  site loads Cloudflare's challenge-platform script, so that script alone is no block.
- Recognition makes the same request. No detection rule offers Courier Center, so preflight
  does not ask it.

## Notes

- Each scan's date and time are the station's wall clock to the minute, read in Athens and kept
  as instants. BOX NOW's UTC scan times for a parcel handed to it show on this page as Athens
  wall clocks, and ELTA's tracker shows the same wall clocks as this page for the parcels it
  takes over. Stations in Cyprus keep Athens' offset all year. An hour repeated when the clocks
  go back is read at its first occurrence.
- The scans are Greek wording without codes, mapped in [`status.ts`](status.ts). Older pages
  write the same scans in capitals, and both map alike. Messages to the recipient, the
  recipient's own instructions and a payment link move nothing.
- The status over the scans, such as `(29) DeliveryCompleted`, settles a delivery, a return, a
  compensation or a parcel waiting at a Clever Point. Otherwise the newest scan with a stage
  decides. A shipment with a status and no scans is read from the status alone.
- The page's own script hides bag scans, departures, the web order and some partner rows in the
  browser, and rewrites some wording. The adapter keeps every row in the server's wording. The
  English store shows the same Greek scans, so the adapter reads the Greek page.
- A delivery's line names who took the parcel and when, a message names the masked phone it
  went to and can carry a link to reroute the parcel, and a failed attempt has a notice number.
  Those parts are dropped, and every line loses phone numbers and email addresses. The sender's
  and recipient's towns, the delivery station's phone, the references and the piece count are
  not kept.
- When Courier Center hands a parcel over, its waybill field reads `{waybill} / {number}` with
  an ELTA item code or a BOX NOW parcel id, and the partner's scans follow on the same page.
  The adapter reports that partner and its number. ELTA's offices lose the postcode before
  their name.
- Places are Courier Center's branches and hubs, or ELTA's offices. The web order and the head
  office's message rows name no place the parcel is.

## Limitations

- No delivery estimate, weight, sender or pickup point.
- Old waybills come back as not found.

## Numbers

Courier Center waybills seen in lookups archived from its tracker and in an aggregator's
samples are twelve digits starting `013`. Twelve digits are shared with Speedex and other
carriers, so no rule claims them, and the adapter takes any twelve digits. The tracker also
answers DHL parcel numbers (`JJD` and eighteen digits) that Courier Center delivers, with its
scans under the DHL number. Those stay with DHL, and the adapter does not take them. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form posts the number as `tracknr` to `www.courier.gr/track/result/`, and
`?tracknr={number}` in the address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/courier-center`, with `COURIER_CENTER_TRACKING_NUMBER`
and optionally `COURIER_CENTER_UNKNOWN_NUMBER` set outside the repository.
