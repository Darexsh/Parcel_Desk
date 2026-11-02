# TracX Logis

TracX Logis is the new name of Qxpress, a cross-border delivery company that ships between
Korea, Japan, Singapore, Hong Kong and Taiwan and delivers Qoo10 orders. Older labels and
emails still say Qxpress. A Japanese or Korean delivery company often takes the last mile.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.tracxlogis.com/tracking` with the header
   `Next-Action: {id}` and the body `["{number}"]`, as the page calls its `getTrackingHistory`
   server action. It needs no account, cookie, token, key or browser.
2. `action`: when the tracker no longer has the id, Next answers HTTP 404 with
   `x-nextjs-action-not-found`, or the page itself. The adapter then reads the page, takes the
   chunks its streamed server components list for the tracking view, and reads them from the
   last one back, eight at most and each with a size limit, until one binds an id to
   `getTrackingHistory`. It asks once more with that id. A page that binds no new id is a
   changed lookup, a schema error, never a missing parcel. A read id is tried first for six
   hours after it last answered.
3. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try, and the `action` step, get half of what is left.

- The reply is a React Server Components stream whose row 0 names the row holding the result:
  `dataInfo`, the parcel's summary, and `history`, its scans. An unknown number comes back with
  every summary field null and no scans, which is not found. A known parcel without scans is
  inconclusive, and so is an error row in place of the result; a Next redirect there is a moved
  route. A 403 or a browser check is a challenge, a 429 a rate limit, and a redirect, a plain
  404, a 405 or a 410 a moved route.
- The tracker also finds a parcel by its delivery company's number or its internal parcel
  number, so the summary's `ShippingNo` must be the whole number asked. Recognition makes the
  same request.

## Notes

- Every visitor's page carries the same action id, which changes with each build. The view's
  chunk builds it with `createServerReference` next to the page's other actions; only the id
  bound to `getTrackingHistory` is taken.
- Each scan's `UTCDate` is an instant in UTC: the older Qxpress lookup gives the same scans as
  wall clocks eight hours ahead in Singapore and nine in Korea and Japan. Scans are newest
  first, at their instants, without a local clock.
- Scans carry newer codes, such as `L60`, beside the older two-letter ones, which the site's code
  labels. The newer code is kept, with the reason after a colon, such as `DX:OT`, and the
  reason's wording after the scan's. A delivery round or delivery with the reason `RO` is the
  return to the sender. An unknown code goes to the shared wording rules.
- The summary names the last-mile company and, in `TrackingNo`, its number; a parcel delivered
  by a courier TracX Logis hires gives its own number there. The number is the delivery number,
  and the company becomes the delivery carrier when TracX Logis's name for it is a catalog
  carrier's and that carrier's rules fit the number: Sagawa, as `Sagawa` or `JD Sagawa`, Japan
  Post, Yamato, and the Korean couriers its site names. K-Packet names no carrier; its Korea Post
  number goes to the destination's post.
- The recipient's name, the order reference, the internal parcel number, the courier in charge
  of each scan and the scans' details, which list flight times in each airport's clock, are not
  kept.

## Limitations

- No ETA, weight, service, sender, address or proof of delivery.
- Some older parcels show only their order record, while the older Qxpress lookup still has
  their history. The page shows the same, and the adapter follows it.
- The page also asks `getTrackingInfoList` for the delivery company's tracking link and split
  parcels; the adapter does not.

## Numbers

TracX Logis's own numbers are QSP and nine digits; the high-confidence rule claims that layout,
and the adapter takes nothing else. Lookups for JP and seven digits stay unclaimed, since no
reply shows their history. Twelve-digit numbers that pass the Japanese mod 7 check and thirteen
digits starting with 6 also reach this tracker; they belong to the Japanese domestic carriers
and Korea Post that take over the last mile, so they are quarantined. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

`tracxlogis.com/tracking` opens one parcel from its `trackingNo` parameter. Old
`qxpress.net/Customer/PopupTraceParcels` links carry the number in `TrackingNo`.

## Testing

`npm run test:carriers:live -- carriers/tracx-logis`, with `TRACX_LOGIS_TRACKING_NUMBER` set
outside the repository. Optionally set `TRACX_LOGIS_UNKNOWN_NUMBER` to a QSP number the tracker
does not know: it is read as not found, directly and after an action id the tracker does not
have.
