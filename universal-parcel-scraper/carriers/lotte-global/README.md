# Lotte Global Logistics

Lotte Global Logistics (롯데글로벌로지스) runs the South Korean parcel service 롯데택배,
formerly Hyundai Logistics. Tracked through the result page its tracking form opens.

## How it works

1. `direct`: one `POST https://www.lotteglogis.com/home/reservation/tracking/linkView` with the
   form body `InvNo={number}`, the page the tracking form's own lookup lands on. It needs no
   cookie, token, key or browser. The HTML has a summary table, which echoes the waybill with its
   pickup and delivery branches and a delivery result, and a history table, newest scan first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The summary must echo the number asked.
- A waybill the tracker does not know comes back with `***` for both branches, no delivery
  result and the line 보내시는 고객님께서 상품 발송 준비중입니다. in place of scans: not found.
- A waybill it knows without scans has its real branches and a delivery result such as 미출고,
  a label not handed over yet, or 예약취소, a cancelled booking. The result is that word alone,
  marked summary only.
- The tracker answers HTTP 200 for every waybill. A 404 or a redirect is a moved page. While the
  site is down it serves a page titled 점검 중 (Under Construction).
- No rule claims Lotte's numbers, so recognition never asks the adapter and it has none.

## Notes

- The tracker's form script (`/home/reservation/tracking/index`) refuses a waybill that is not
  twelve digits ("운송장번호는 12자리입니다.") or whose last digit is not the rest of the first
  eleven divided by seven ("운송장번호가 잘못되었습니다."). The page answers such a number with no
  waybill in its summary, the same as an empty one, so the adapter refuses it as invalid input
  without a request.
- Every scan is at a Korean branch, terminal or delivery centre, and the page shows Korean wall
  clocks to the minute. Korea keeps one offset all year, so a clock read in `Asia/Seoul` is an
  instant; each scan has that instant and its wall clock as `local_time`.
- Some rows show their day with `--:--` for the time. Old waybills have only such rows, and
  recent ones list the pickup twice, once that way. A row without a time keeps its day as
  `local_time` and no instant, and goes when a timed row of the same day repeats it.
- A scan's step (단계), such as 배송 출발, is its provider code and stages it. Its wording is
  Korean, as the page shows it.
- The out-for-delivery scan gives the courier's window, as 14~16시. While that scan is the latest,
  the window on its day is the delivery estimate.
- Delivery and out-for-delivery scans name the courier with a mobile number in brackets; both are
  removed. The delivered row placed at 고객, the customer, has no location. The summary's
  branches and the page's progress rail are not kept.
- ALPS, Lotte's logistics platform, serves the JSON lookup
  `https://ftr.alps.llogis.com:18260/openapi/ftr/getCustomerInvTracking?invNo={number}` behind
  its own public tracking page. It is not used: it runs on a non-standard port, returns the
  recipient's masked name, phone and address, sends its rows out of order, leaves out hub
  arrivals the tracker shows, and gives some steps a fixed placeholder time. Its
  `getCustmerNviewTracking` needs a registered partner.

## Limitations

- No weight, service, sender or recipient.
- Clocks are to the minute, and older scans have only their day.

## Numbers

The waybill (운송장번호) is a bare twelve-digit number ending in the mod-7 check digit described
above. Yamato, Sagawa, Japan Post and other Korean carriers use the same check on twelve
digits, so no rule claims these numbers. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page links to the result page on `/home/reservation/tracking/linkView` and its
mobile twin, which take the number in `InvNo`. `/open/tracking`, an older link, takes it in
`invno`.

## Testing

`LOTTE_GLOBAL_TRACKING_NUMBER=... LOTTE_GLOBAL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/lotte-global`
