# To-Day

To-Day (투데이), run by VtoV (브이투브이), collects parcels and routes them through its own stations
for same-day delivery in Korea. It also delivers AliExpress parcels after customs clearance.
Returns of standard parcels in its Incheon small-business programmes are carried by Hanjin.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://my.amazing.today/track/{number}`. The page's server looks the
   number up and puts the answer in the page's Next.js data (`__NEXT_DATA__`), sealed with
   `CryptoJS.AES.encrypt` under a passphrase the page's own script carries to open it. The
   adapter opens it the same way. It needs no cookie, token or browser.

- An unknown number is the page's own `NOT_FOUND` answer. A 404 or a redirect is a moved route,
  and Vercel's bot checkpoint is a challenge.
- The page shows nothing for a parcel delivered more than three months ago and answers
  `EXPIRED`, which is inconclusive with the reason `history_expired`.
- The shipment must carry the number asked, as To-Day's own waybill or as the number the page
  shows for it: AliExpress's number for an AliExpress parcel, the partner's for one handed on.
- Recognition makes the same request.

## Notes

- Times carry Korea's `+09:00` offset, so scans are instants. A time without one would be read
  in Asia/Seoul: Korea keeps one zone and no daylight saving.
- The history is the one the page draws: the pickup (`픽업`, or `인수` for a return), the
  arrival at and departure from each station it lists (`도착`, `출발`), and the delivery
  (`배송완료`). The page folds a route's first or last station into the pickup or the delivery;
  a first station the parcel reached after its pickup adds its arrival.
- The steps of the progress rail no row dates are added: the first departure (`배송시작`), and
  the departure from the last station towards the door (`배송중`), which replaces that
  station's `출발` row and is out for delivery.
- The page's state sets the stage. A held delivery is a failed attempt worded with the page's
  headline, which names why. A lost or stopped parcel is an exception. A pickup or return
  answer has no state; its newest row sets the stage.
- A pickup or delivery at an address keeps no place, and neither does a shipper's own pickup
  point, which carries the shipper's name. Stations keep their names. Names, coordinates,
  products and references in the answer are not kept.
- A parcel handed on to Hanjin, CJ Logistics or Korea Post EMS carries the partner's name and
  number in the answer, and the page shows that number as the waybill. The adapter reports the
  hand-off when the number has the partner's shape. A parcel a broker carried part of the way
  that To-Day still delivers has none.

## Limitations

- No weight, estimate or proof of delivery. The headline's estimate is a clock time the page
  works out from the departure; it is not kept.
- The passphrase is part of the page's script. A new one makes every answer fail to open until
  the adapter has it.

## Numbers

To-Day's tracker takes a twelve-digit waybill, which it prints in groups of four, and archived
lookups show that layout. Its search box also takes thirteen characters, the length of some
partners' numbers. Twelve digits are a shape many carriers share, so no rule claims it: a lookup
names To-Day or comes from its tracking link. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

Archived lookups show that `my.amazing.today/track/{number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/today-kr`, with `TODAY_KR_TRACKING_NUMBER` and
optionally `TODAY_KR_UNKNOWN_NUMBER` and `TODAY_KR_EXPIRED_NUMBER`, a parcel delivered more than
three months ago, set outside the repository.
