# Logen

Logen (로젠택배) is a South Korean parcel network. Its branches collect and deliver parcels
across Korea, through hub terminals between them. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.ilogen.com/web/personal/trace/{number}`, the page the
   tracking form opens. It needs no cookie, token, key or browser. The server renders the
   parcel's details and a table of its scans, oldest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with the page's own `배송자료를 조회할 수 없습니다` answer,
  which is not found. A 404 or a redirect is a moved route.
- The page answers a number that is not ten or eleven digits with an alert instead of a lookup,
  which is an invalid input.
- The parcel's details must give the number asked as its 송장번호.
- Recognition makes the same request.

## Notes

- The adapter refuses eleven digits whose last digit is not the first ten modulo 7. The tracker
  does not check it, and answers such a number as not found, but every real sample passes it,
  so a number that fails is a typo or another carrier's and costs no request.
- Each scan's clock is a wall clock to the minute, with no zone. Every scan is at a Logen
  branch or hub terminal in Korea, which keeps UTC+9 all year, so the clocks are read in
  `Asia/Seoul` and each scan gets a `time`, and a delivery a `delivered_at`.
- A scan's 배송상태 label, such as `배송완료`, is its `provider_code` and stages it. Its 배송내용
  line is the description, or the label when the line is empty. A delivery with a photo adds a
  사진확인 link to its label, which is not kept.
- The receiver column of an out-for-delivery scan gives the delivery window, such as
  `16시~18시`, on the scan's day. It becomes `expected_delivery_from` and `expected_delivery`
  while that scan is the newest. A later delivery day given there is not read.
- The staff, receiver, office and phone columns are not kept, and lines lose phone numbers. The
  sender, recipient, address, goods and parcel count in the details are not kept either.
- The mobile page `/m/personal/trace/{number}` and its pop-up `/m/personal/trace.pop/{number}`
  show the same scans without their labels and sites.

## Limitations

- No weight, service or delivery photo.
- Ten-digit numbers, which the tracking form also takes, are refused.

## Numbers

Logen waybills are eleven digits, printed in groups of three, four and four with hyphens. The
tracker asks for the eleven digits without hyphens. The last digit is the first ten digits
modulo 7, the check Japan Post, Yamato, Sagawa and other Korean carriers use too. Eleven digits
with that check are printed by many carriers, so no rule claims them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking form opens `www.ilogen.com/web/personal/trace/{number}`, and the mobile site
`/m/personal/trace/{number}`. Archived lookups also use the mobile pop-up
`/m/personal/trace.pop/{number}`, the former `iLOGEN.Web.New/TRACE/TraceView.aspx` page with
the number in `slipno`, and the older `d2d.ilogen.com` tracker, which now fails.

## Testing

`npm run test:carriers:live -- carriers/logen`, with `LOGEN_TRACKING_NUMBER` and optionally
`LOGEN_UNKNOWN_NUMBER` set outside the repository.
