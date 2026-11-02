# CJ Logistics

CJ Logistics (CJ대한통운) runs South Korea's largest domestic parcel network. Tracked through
the lookups of its tracker on `trace.cjlogistics.com`.

## How it works

1. `direct`: one `POST https://trace.cjlogistics.com/next/rest/selectTrackingDetailList.do`
   with the form body `wblNo={number}`, as the tracker on `/next/tracking.html` sends it. It
   needs no cookie, token, key or browser. The JSON reply lists every scan, oldest first, each
   naming the waybill.
2. `retry`: the same read once more after a failed connection or a timeout. The first read gets
   half of the budget.

- When the list is empty, the adapter posts the same body to `selectTrackingWaybil.do`, as the
  tracker does. Its `data` is null for a number CJ Logistics does not know, which the tracker
  reports as an invalid waybill and the adapter as not found. A record of the number is a
  waybill registered before its first scan, which has no history yet.
- The tracker reads a missing parcel from a 200 reply: a 404, a 405 or a redirect is a moved
  route. A `resultCode` other than 200 is a lookup the service did not complete.
- Every scan must name the number asked.
- Recognition makes the same requests.

## Notes

- Each scan's `workDt` and `workHms` are the branch's wall clock to the second, with no zone.
  Every scan is made at a branch or terminal of the Korean network, so the clocks are read in
  `Asia/Seoul`, and each event has its instant.
- A scan's description is its name, then the tracker's line for it, such as
  `배송출발: 고객님의 상품을 배송할 예정입니다.(11~13시)`. The code (`crgStDcd`) stages it; a
  code the map does not know falls to the shared wording rules.
- Departure and delivery lines lose the courier's name and mobile number, and every line loses
  phone numbers. The delivery's receiver, which the reply puts in the partner branch field, the
  staff names and the branch phone numbers are not read. A direct route's branch label
  (`…직영`) loses the driver's name it carries in brackets.
- Couriers sometimes record a departure scan after the delivery. A delivery stays the parcel's
  stage while the newest scan after it is a pickup, a trunk move or a departure.
- The `SM입고` scan reads as an arrival at the destination, yet trunk scans can follow it. It
  stays in transit.
- The tracker on `www.cjlogistics.com` takes a page load for its `_csrf` token and session
  before its `tracking-detail` lookup, and shows fewer scans. It is not used.

## Limitations

- The lookup keeps scans for three months. An older parcel loses its first scans, then reads
  as not found, as on the tracker.
- No estimated delivery, weight or service.
- The `www.cjlogistics.com` tracker shows Korea Post's number for parcels it delivers on CJ's
  behalf. The trace lookup does not, so there is no hand-off.

## Numbers

The waybill (운송장번호) is a bare twelve-digit number; the tracker also takes ten digits. The
last digit is not a mod-7 check as with other Korean carriers, and bare twelve-digit numbers
are printed by many carriers, so no rule claims them and detection never offers CJ Logistics.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker on `www.cjlogistics.com/ko/tool/parcel/tracking` and `newTracking` takes the number
in `gnbInvcNo`, and the one on `trace.cjlogistics.com/next/tracking.html` in `wblNo`. The older
trace pages `/web/detail.jsp` and `/web/info.jsp` took it in `slipno`, and the former tracker on
`doortodoor.co.kr` used `/parcel/doortodoor.do` with the number in `invc_no`.

## Testing

`npm run test:carriers:live -- carriers/cj-logistics`, with `CJ_LOGISTICS_TRACKING_NUMBER` and
optionally `CJ_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
