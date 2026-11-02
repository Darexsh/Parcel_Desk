# Hanjin

Hanjin Transportation runs the South Korean parcel service 한진택배, which also delivers parcels
its international express arm flies in. Hanjin Shipping, the container line, is a different
company. Tracked through the result page of its tracking form.

## How it works

1. `direct`: one `GET https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&wblnum={number}&schLang=KR`,
   the page the tracking form posts to. It needs no cookie, token, key or browser. The HTML has
   the number, a summary of the newest scan, a basic table, a progress rail and the scans, oldest
   first.
2. `retry`: a request that fails to reach Hanjin, or hangs, is sent once more within the budget.

- An unknown number gets a small notice page whose script alerts "운송장이 등록되지 않았거나
  보내는 분(업체)이 상품을 준비 중 입니다." and posts back to the search form. Older result pages
  showed the same notice with no scans. That notice is the only not-found answer.
- The page must show the number asked.
- The Korean page is read. `schLang=EN` has other markup and translates the scans loosely.
- Recognition makes the same request.

## Notes

- Each scan has a date and a minute, with no zone. Scans in Korea are on Korean time, which has
  no daylight saving, so they are read in `Asia/Seoul` and a delivery gives `delivered_at`. A
  parcel from abroad, on an international waybill or a domestic one, first shows the foreign
  carrier's scans on their local clock, as the page says, sometimes marking them with an
  asterisk. A history with a foreign leg (an international waybill, a marked clock or a flight)
  keeps every scan before its first Korean customs scan, and every marked one, in `local_time`.
- The scans are Korean sentences without a code, most naming a terminal or a flight.
  [`status.ts`](status.ts) matches them as patterns, ignoring spaces, and the newest scan gives
  the stage. The progress rail is not read.
- The wording sits in its own element. The collector's or courier's name and phone, the call
  centre's number and the customs link after it are not read, nor are the basic table's goods,
  sender, recipient, town, charge, master bill and duties.
- The tracking form takes twelve or fourteen digits. On every twelve-digit waybill found the last
  digit is the rest of the first eleven divided by seven, so one that fails the check is invalid
  input. Fourteen digits are sent as they are.

## Limitations

- No weight and no estimated delivery.
- The tracker keeps about three months of history; an older waybill reads as not found.
- The not-found notice also covers a parcel the sender has not handed over yet.
- Ten-digit numbers from the former tracker are refused, as the current form refuses them.

## Numbers

The waybills seen are twelve digits, and archived lookups on the former tracker also carry
ten-digit ones. In all of them the last digit is the rest modulo 7, the check Yamato, Sagawa,
Japan Post and other Korean carriers use too. Bare digits with that check are printed by many
carriers, so no rule claims them: a caller names Hanjin or pastes its link. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking form posts its number, but the result page also answers a plain address, so
`www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&wblnum={number}&schLang=KR`
opens one parcel. The former tracker on `hanjin.co.kr` used
`/Delivery_html/inquiry/result_waybill.jsp` with the number in `wbl_num`.

## Testing

`npm run test:carriers:live -- carriers/hanjin`, with `HANJIN_TRACKING_NUMBER` and optionally
`HANJIN_UNKNOWN_NUMBER` set outside the repository.
