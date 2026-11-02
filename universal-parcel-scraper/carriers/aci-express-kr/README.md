# ACI Express

ACI Express (에이씨아이월드와이드) is a Korean international courier. Its e-commerce service picks up
parcels bought abroad, flies them to Incheon, clears them through customs and hands them to Korea
Post or CJ Logistics for delivery. Tracked through its e-commerce tracking page.

## How it works

1. `direct`: one `GET https://www.acieshop.com/pod.php?OrderNo={number}`, the tracking page the
   courier lookup sends a number it does not know to. It needs no cookie, login, key or browser.
   The server renders ACI's own milestones, then the delivering carrier's scans under a heading
   that names it, both oldest first.
2. `retry`: one more try when the first fails to reach the site or hangs.

- A number the page does not know gets HTTP 200 with the same page, without the number or
  scans. The adapter then asks `GET https://133.acieshop.com/webpod.php?HawbNo={number}`, the
  courier lookup on ACI's delivery page, inside the same step. Its whole answer for a number it
  has no shipment for either is a script opening the tracking page for that number, which is
  not found. Any other answer is a courier shipment, which the adapter does not read, so it is
  inconclusive.
- A redirect, a 404 or a 410 is a moved route.
- The page must show the number asked; a page for another number is inconclusive.
- Recognition makes the same requests.

## Notes

- The delivery page's e-commerce lookup opens a popup at `acieshop.com/aci_pod/pod.php?BL={number}`
  that refuses a visit without the delivery page as its referrer, so a link to it from an app
  shows a refusal. The tracking page above reads the same records, opens on its own and adds
  each scan's area and the delivering carrier's scans, so the portal link opens it too.
- The page says its clocks are each service area's local time. The pickup and the flight are on
  the origin's clock and the scans in Korea on Korea's, so a later scan can read an earlier
  clock than the one before it. Every scan stays `local_time`, the pickup often as a day alone,
  and the events keep the page's order, newest first.
- ACI's and Korea Post's rows are in Korean with an English line, which is the scan's wording.
  CJ Logistics' rows are in Korean only, and a row without wording is no scan. Customs
  clearance at Incheon is `in_transit`: the parcel moves on to the delivering carrier.
- The popup words the arrival at Incheon as arrived (expected), so the arrival can be the
  scheduled landing.
- Korea Post carries the parcel on under the same thirteen-digit number, which its rules claim,
  so the parcel is handed to it under that number. The page does not show CJ Logistics'
  waybill, and CJ's rules claim no number, so a CJ parcel has no hand-off.
- The recipient's masked name, the column naming the postman or the delivery's outcome, the
  driver CJ's direct routes name in a branch and the line naming who took the parcel are not
  kept.

## Limitations

- The bill tracker at `wms.acieshop.com` no longer answers, so ACI's export bills have no
  tracker.
- Shipments on the courier lookup are not read.
- No delivery estimate, weight, service or delivery time as an instant.

## Numbers

The tracking page takes the thirteen-digit Korea Post registered number a parcel travels under,
and archived lookups show that layout with ACI's own pickup, flight and customs scans. Those
numbers stay with Korea Post's rule. It also takes ACI's own twelve-digit numbers, a shape many
carriers share, so no rule claims them. Without a rule of its own, ACI is not asked during
recognition. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Archived lookups use the older `acieshop.com/pod.html?OrderNo={number}`,
`www.acieshop.com/trackingbl.html?bl={number}` and `pod.acieshop.com/tracking.php?bl={number}`,
and bill numbers opened at `wms.acieshop.com/comn/deliveryTrack/{number}`. The delivery page
links the courier lookup over plain HTTP.

## Testing

`npm run test:carriers:live -- carriers/aci-express-kr`, with `ACI_EXPRESS_KR_TRACKING_NUMBER`
for a parcel Korea Post delivers and optionally `ACI_EXPRESS_KR_CJ_NUMBER` for one CJ Logistics
delivers and `ACI_EXPRESS_KR_UNKNOWN_NUMBER` set outside the repository.
