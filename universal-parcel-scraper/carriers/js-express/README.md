# JS Express

JS Express (急速国际), run by 急创速供应链管理（苏州）有限公司, ships parcels abroad from China
for online shops, through dedicated lines, express and postal services, and a local carrier
delivers them. Tracked through the lookup its English tracking page makes.

## How it works

1. `direct`: one `POST https://www.js-exp.com/EN/index.php?c=trace` with the form body
   `card_num={number}`, as the script of the English tracking page `EN/index.php?page=19` sends
   it, with that page as the referrer. It needs no cookie, token, captcha or browser. The reply
   is JSON, served as HTML: the waybill, the country it goes to, the destination courier's
   number once it has one, and the scans newest first.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown number gets `code` 1 and "未获取到任何数据,请提供有效单号!", which is not found. A
  waybill without scans, which the page's script shows as "暂无轨迹数据", has no history. An
  empty reply is inconclusive. A 403, a Cloudflare check, a captcha prompt or the lookup's
  refusal alone in place of the answer is a challenge. A 404 or a redirect is a moved route.
- The reply must name the whole requested number as `jsWaybillNo`. The tracker matches whole
  numbers only.
- Recognition makes the same request.

## Notes

- The Chinese tracking page's query button posts to `index.php?c=test` and asks for an image
  captcha first. The home page's form renders the same scans without it, but not the courier's
  number or the country. The English page's lookup gives both without a captcha, so the adapter
  uses it.
- Without the tracking page as its referrer, the lookup prints the refusal "非法请求" and then
  answers anyway. The adapter sends the referrer and drops a refusal printed before an answer.
- `trackNo` is the destination courier's number and becomes the delivery tracking number; a USPS
  routing barcode gives its package identifier. The reply does not name the courier. It is the
  carrier the catalog settles the number for at high confidence, when that carrier works in the
  country the parcel goes to, and the tracker then asks that carrier's adapter.
- A row is a clock, a place and a wording. Clocks are wall clocks to the second, with
  no zone, and one history mixes China's with the airports' and the destination courier's, so
  the reply's order stands.
- A row at a place in mainland China, named for the country, a region such as South China, a
  province or a city, or written in Chinese other than Hong Kong's, Macau's or Taiwan's, is on
  Beijing time. A flight's departure filed there keeps its wall clock:
  one has come hours after its flight could have left, given the landing that followed.
- In a history that names Straightship, its rows are on UTC, the clock of Straightship's own
  page: those that name it, those whose wording ends with a town and a Canadian province, and its
  placeless "Package information is created in the system", which its page shows on the same wall
  clock.
  Straightship's record of the parcel's data comes within a minute of the Chinese warehouse's
  inbound scan only when the one is read on UTC and the other on Beijing time, and its
  deliveries then come before the 9 pm its round promises.
- Rows at an airport's code or without a place keep `local_time`, as do other couriers' rows:
  iMile's name no country. Each row also carries an offset, which the adapter does not read:
  Straightship's rows carry China's, and Amsterdam's carry its winter offset in summer. The newest row's instant, when it has one, is the last update, and a
  dated delivery's is the delivery time.
- JS Express's own rows and its partners' share the history in their partners' words. A
  destination courier's wording repeats the place with its province, as "Delivered (Sample Town,
  ON)": the adapter moves it into the location, so the wording stays the same from town to town.
  A place without a letter, such as "1", names no place and is left out.
  JS Express's own status in Chinese shows the English its entry in
  [statuses.json](statuses.json) gives, and takes over the row stored in Chinese.
- iMile's scans as the destination courier open with the centre's name in 【】, so each pair of
  centres makes a new wording. They take the stage iMile's own sentences give, as its adapter
  reads them.
- Partners' records of the parcel's data move nothing and have no stage. Straightship's "Package
  will be delivered before 9:00pm" is its driver's round, out for delivery, as Straightship's own
  map reads it.
- A courier's announced return, such as Colissimo's "Il va être retourné à l'expéditeur", is an
  exception: the parcel is returned only once a scan has it back with its sender.
- A delivery loses a clause naming who took the parcel, and every row loses phone numbers and
  the label left before them, as JS Express's "当地电话：" (local phone) or "Local phone number:/".

## Limitations

- The reply has no summary, weight or service, and does not name the destination courier.
- The delivery estimate, the delivery photos and the shop's order number are not read.

## Numbers

JS Express waybills are `JSE`, two capital letters, ten digits and `YQ`, the layout 17FEIA,
WanbExpress, SFC and CJ Packet use with prefixes of their own. The `JSE` prefix is JS
Express's own, so `js-express-1` claims the layout and the adapter takes nothing else. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/js-express`, with `JS_EXPRESS_TRACKING_NUMBER` set
outside the repository. Optionally set `JS_EXPRESS_DELIVERED_NUMBER` to check a delivered
waybill and `JS_EXPRESS_UNKNOWN_NUMBER` to check a number the tracker does not know.
