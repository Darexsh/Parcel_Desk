# Seino Transportation

Seino Transportation (西濃運輸) is a Japanese parcel and freight carrier. Its branches collect,
sort and deliver across Japan under the Kangaroo (カンガルー便) name, and partner companies take
some shipments on for the last leg. Tracked through its tracking page.

## How it works

1. `direct`: `GET https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1={number}` returns the
   tracking page with the lookup done: a list row with the number, its receipt date and its
   status, then the shipment's detail. It needs no cookie, key or browser. The page is Shift_JIS,
   which the site names Windows-31J, and is decoded as its header or meta tag declares.
2. `retry`: one more read after a network failure or a timeout.

- An unknown number gets "入力されたお問合せ番号が見当りません" in its list row. Only that answer
  is not found. A list row for another number is inconclusive.
- The page's own check of a number prints it followed by "エラー", which is invalid input. It
  refuses other lengths and letters, which the adapter refuses before asking.
- A firewall or bot check is a challenge, with HTTP 403 or 200. HTTP 429 is rate limited, and a
  maintenance notice or HTTP 503 is maintenance. A redirect or a 404 is a moved page.
- Recognition makes the same request.

## Notes

- The detail lists fixed milestones, each with the branch and the time it was reached: 受付,
  発送, 中継, 到着, 持出 and 配達, with 配達回送 added for a shipment handed on to a partner
  company. A milestone not reached shows no time, sometimes with the branch it is planned at,
  and is left out. Each scan's description is the milestone's label without the spaces the page
  puts in it.
- A milestone's time is a day of the month and a time, as in `3日10時45分`. The receipt date in
  the list has a month and a day, and the page carries its own clock in a hidden field. The
  receipt is the latest such day up to the page's clock, and each milestone falls on the first
  such day from the one before it. Every branch is in Japan, so the times are Japan's clock with
  its offset.
- The status code in a hidden field, with the sentence the list shows, stages the shipment. The
  page's script files more codes under its progress steps, but a step can hold a failed run or a
  return too, so codes not seen with their sentence stay unmapped. An unmapped code leaves the
  stage to the newest milestone.
- The product (ミニ or 一般) is the service name, and the weight is in kilograms. The piece count,
  the branches' phone numbers, the driver's phone, the vehicle, the destination area code and
  the delivery map are not kept.

## Limitations

- One time per milestone: a shipment delivered on a second run shows the last run's times, and
  only its status sentence tells of the redelivery.
- The tracker answers for two months after the shipment was received, then reports it unknown.
- No estimate: the page asks for it in a second request, which the adapter does not make. No
  sender, recipient or proof of delivery.

## Numbers

The inquiry number (お問い合わせ番号) has ten digits, sometimes printed with hyphens. It has no
check digit: consecutive numbers archived from the tracker are both shipments, and neither the
page's script nor the server checks more than the length. Bare ten-digit numbers are printed by
many carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`track.seino.co.jp/cgi-bin/gnpquery.pgm` takes the number in `GNPNO1` and opens its status.

## Testing

`npm run test:carriers:live -- carriers/seino`, with `SEINO_TRACKING_NUMBER` and optionally
`SEINO_UNKNOWN_NUMBER` set outside the repository.
