# Prompt Xpress

Prompt Xpress is a domestic courier based in Ratmalana. It carries documents and parcels
between its branches across Sri Lanka, most within a day. Tracked through the visibility portal
its tracking page links a parcel to.

## How it works

1. `direct`: one `GET https://web.promptxpress.lk/PublicTracking/TrackingStatus?trackingNo={number}`.
   The tracking page on promptxpress.lk posts the number back to itself with ASP.NET's hidden
   fields and answers a found parcel with a status line and a link to this page, which looks
   the number up on the server. It needs no cookie, token, key or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number the portal holds nothing under gets the notice `No tracking data was found for` and
  the number. That notice is the only missing parcel; a notice naming another number, or any
  other notice, is inconclusive. A 404, a 410 or a redirect is a moved route. The tracking page
  itself shows nothing at all for an unknown number.
- The page must show the number asked in its field, over the result and beside the summary.
- Recognition makes the same request.

## Notes

- The portal shows the newest movement only: its status, the branch it happened at and its
  clock, beside a count of scans it does not list. The result is that one scan, marked
  `summary_only`.
- The clock names no zone, and nothing on the page or in the tracking page's answer settles
  whether it is Sri Lanka's or the cloud host's behind the portal, so it stays a wall clock in
  `local_time`.
- `Consignment Completed` is a delivery: the tracking page names the same parcel Delivered.
  A completed consignment can stand at the head office rather than a delivery branch, so its
  clock is not taken as the delivery time.
- The proof of delivery, an image or a link, is not read.

## Limitations

- No history, estimate, weight, delivery time or clock with an offset.
- Parcels from earlier years get the no-data notice.

## Numbers

The former tracking page gave the formats as `MC` or `RP` and eight digits, or `SP` and nine
digits. Archived addresses on its site show the two-letter layout, one with `NC`, and the
portal knows a recent `RP` number. `prompt-xpress-1` suggests the carrier for these layouts at
low confidence, since TNT Italy prints similar numbers, and recognition asks the portal.
Complaints give `SP` numbers with eight digits. The adapter accepts them, but the rule leaves
them out while the tracker holds none of them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The portal opens one parcel at `web.promptxpress.lk/PublicTracking/TrackingStatus?trackingNo=`
followed by the number. The tracking page on promptxpress.lk posts the number in a form, so no
address of its own opens one item, and the former site's `/Home/Tracking/{number}` addresses
are gone.

## Testing

`npm run test:carriers:live -- carriers/prompt-xpress`, with `PROMPT_XPRESS_TRACKING_NUMBER` and
optionally `PROMPT_XPRESS_UNKNOWN_NUMBER` set outside the repository.
