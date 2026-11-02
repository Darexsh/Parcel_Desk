# CrossCountry Freight Solutions

CrossCountry Freight Solutions (CCFS) is a less-than-truckload carrier based in Bismarck, North
Dakota, serving the northern and western United States. Tracked through the lookup its shipment
page makes.

## How it works

1. `direct`: one `GET` of
   `https://auth.ccfs.com/api/web/V2/Consignments/Basics?TrackingNum={number}&TrackingNum={number}&Descending=false`,
   as the shipment page at `auth.ccfs.com/track/detail/{number}` makes it. It needs no cookie,
   token, key or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number the lookup does not know is HTTP 404 with a message naming it. A 404 naming another
  number is inconclusive. Any other 404, a 410 or a redirect is a moved route.
- The lookup matches a pro number, a freight bill number or a shipper's reference, so its reply
  can list several shipments. The adapter keeps the one whose pro or freight bill number is the
  number asked; a reply without it is inconclusive and nothing from it is kept.
- The adapter asks by whole pro or freight bill number only; references, bills of lading and
  purchase orders are not used.
- Recognition makes the same request.

## Notes

- No clock names its zone, so clocks stay wall clocks in `local_time` and no event has an
  instant.
- The history is listed oldest first unless the reply says `Descending`. The result keeps the
  reply's order rather than sorting by clock. System rows carry fractions of a second, and the
  delivery row is stamped when the delivery was recorded, which can be hours after the driver
  left.
- The page's progress rail runs from the pickup request to the delivery. A delivery, from a row
  or the rail, settles the shipment; a problem in the newest staged row comes next; otherwise
  the further of that row and the rail decides. A rail step ahead of every row has no clock.
- Until the delivery, the estimate is the day the delivery window opens.
- A freight bill number's result is headed by the shipment's pro number, as the page does.
- The map covers the status descriptions CCFS publishes at
  `www.ccfs.com/api/public/Service/StatusDescription`. Notices, notifications, appointments and
  billing rows have no stage.
- The reply holds the shipper's and the consignee's towns with their ZIP codes, the pickup day,
  the delivery's arrival and departure, its signer and comment, its images and partners'
  tracking links; none of them is read. A row's place keeps its town and state without the ZIP
  code.

## Limitations

- No sender, recipient, signature or delivery receipt. The page shows the receipt only once the
  consignee's address is entered.
- A number reaches the adapter when it is filed under CCFS or opened from a CCFS link: both
  shapes are shared with other carriers, so no rule claims them and preflight does not ask it.
- Sister brands share the platform and the reply names no company, so the adapter cannot tell
  their shipments from CCFS's.

## Numbers

CCFS tracks freight by a twelve-digit pro number and a freight bill number of one letter and
seven digits; the lookup answers both for the same shipment. The archived public sample's
tracker names its signer, so [`numbers.json`](numbers.json) holds invented numbers of both
shapes.

## Links

`auth.ccfs.com/track/detail/{number}` opens one shipment, and the search page opens one it picked
out of several with the shipment's id after the number. The library reads the number from both.
An unknown number goes back to the search form, prefilled.

## Testing

`npm run test:carriers:live -- carriers/ccfs`, with `CCFS_TRACKING_NUMBER` and optionally
`CCFS_UNKNOWN_NUMBER` set outside the repository.
