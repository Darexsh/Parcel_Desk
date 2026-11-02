# Ilyang Logis

Ilyang Logis (일양로지스), formerly 일양택배, carries parcels across Korea through its offices,
branches and hub terminals. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.ilyanglogis.co.kr/tracking/trackingByDeliNo.do` with the form
   body `trackingType=0&blNum={number}`, the lookup the script of the tracking result page makes.
   It needs no cookie, token, key or browser. The JSON reply holds the parcel as the one entry of
   `rows`, with its checkpoints oldest first in `tracking`.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number the tracker holds no parcel for is HTTP 200 with an entry without checkpoints and
  the notice `미 접수된 물품 이오니 송장번호 재 확인 후 다시 이용해 주시기 바랍니다`, "an item not
  taken in", which is not found. A 404, a 405 or a redirect is a moved route.
- Input that is not a waybill gets `"res":false` and the page's `해당 정보가 없습니다` instead of
  a lookup. The adapter never sends such input, and reads that answer as inconclusive.
- The entry's `blNum` must be the number asked.
- The site refuses a bare client name such as curl's as the User-Agent with a 403 page. The
  package's default User-Agent passes.
- Recognition makes the same request.

## Notes

- Each checkpoint's `actDate` and `actTime` are a wall clock to the minute, with no zone. Every
  checkpoint is at an Ilyang Logis office, branch or terminal in Korea, which keeps UTC+9 all
  year, so the clocks are read in `Asia/Seoul` and each scan gets a `time`, and a delivery a
  `delivered_at`.
- A checkpoint's code, such as `70`, is its `provider_code`, and the label the page shows, such
  as `배달완료`, its description. The map reads the label, then the code. A not-delivered
  checkpoint (`88`) gives its reason in the label's brackets and in a remark, which the
  description adds after a colon, without phone numbers.
- `미배달(인계)` hands the parcel over to CJ Logistics, and its remark gives CJ's waybill after
  `CJ`. The scan is in transit, and the result names `cj-logistics` and that waybill as the
  delivery partner. Ilyang's branch still records the delivery afterwards.
- The sending office can record taking the parcel in (`10`) after the parcel has left it. That
  scan does not take the parcel's stage back.
- The reply also carries the sender's and recipient's names, addresses and phone numbers, the
  person who took the parcel, the goods, the order number, the staff's codes and phones and the
  branches' phones. The page masks the names and shows no address or personal phone. None of
  them is kept.

## Limitations

- No delivery estimate, weight, service or pickup point.
- A parcel whose history the tracker no longer keeps gets the same answer as a number it never
  had, so it is reported as not found.

## Numbers

Current waybills are ten digits; the former tracker's archived lookups show nine. On every
public waybill found the last digit is the rest of the others divided by seven, the check Logen
and Hanjin use too, so the adapter refuses a number that fails it without a request. Many Korean
carriers print digit runs of these lengths, so no rule claims them, and preflight recognition
does not ask Ilyang Logis. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page on `ilyanglogis.co.kr/page/Tracking.do` opens
`ilyanglogis.co.kr/page/TrackingResult.do?trackingType=0&blNum={number}`, which shows one
parcel. The former tracker on `ilyanglogis.com` read the number from `hawb_no` on its
`functionality` result pages.

## Testing

`npm run test:carriers:live -- carriers/ilyang-logis`, with `ILYANG_LOGIS_TRACKING_NUMBER` and
optionally `ILYANG_LOGIS_UNKNOWN_NUMBER` set outside the repository.
