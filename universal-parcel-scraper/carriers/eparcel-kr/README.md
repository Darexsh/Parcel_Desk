# eParcel Korea

eParcel Korea (용성종합물류) flies e-commerce parcels from Korea to other Asian countries and hands
them to a delivery company there, such as Ninja Van in the Philippines or Janio in Singapore.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.eparcel.kr/Track/Result?mode=0&ids={number}&branch=00066&lang=en-US`,
   the page the lookup on the site's front page lands on, with its branch. It needs no cookie,
   login, key or browser. The server renders the parcel's scans newest first and a box of
   details.
2. `retry`: one more try when the first fails to reach the site or hangs.

- The page needs a language. Without `lang`, an `Accept-Language` header or the site's language
  cookie, the server redirects the lookup to its error page; the adapter sends both. A redirect
  to the error page is inconclusive, and any other redirect, a 404 or a 410 is a moved route.
- An unknown number is HTTP 200 with the heading naming the number over `No data.`. A lookup the
  server could not run gets a bare `Unknown error.` page, which is inconclusive.
- The heading and the registration number in the details must both be the number asked; a page
  for another parcel is inconclusive and nothing from it is kept.
- Recognition makes the same request.

## Notes

- The page marks the clocks of registration, the warehouse in Korea and the flight out
  `(local time)`. On a parcel leaving Korea those are Korea's time, which has no daylight saving,
  so they become instants. Later scans' clocks have no mark or zone and stay `local_time`.
- The explanation column names the sender at registration, eParcel itself or a stock phrase at
  the warehouse, and the airport on flights. Only the airport is kept, as the location. The
  delivery company's own lines before the delivery join the scan's wording, without phone
  numbers. Other explanations, the order number and the departure country are not kept.
- The details name the delivery company, often with a link to its site, and its number. The
  company is named as `delivery_carrier` when the catalog knows it, its link is not on another
  carrier's site, and its tracker takes the number: Ninja Van's adapter takes only its own
  country-bearing numbers, while Janio's tracker also finds a parcel by its sender's reference,
  which here is often eParcel's own number. Another delivery number stays as
  `delivery_tracking_number` alone.

## Limitations

- The tracker keeps only the last three months of parcels, so an older parcel reads as unknown.
- No weight, service, delivery estimate or proof of delivery.

## Numbers

The tracker takes a registration number made of E, the destination country code, nine digits
and KR, and archived lookups show that layout. The `eparcel-kr-1` rule claims it. The samples
and their sources are in [`numbers.json`](numbers.json).

The tracker also takes order numbers and the courier numbers of the departure and destination
countries. Those belong to the shipper or to the other carriers, so no rule claims them and the
adapter sends only registration numbers.

## Links

The tracker's search page opens `www.eparcel.kr/Track/Result?mode=0&ids={number}&lang=en-US`
for registration numbers, and archived lookups use that address. The lookup on the front page
opens `www.eparcel.kr/Track/MainTracking?num={number}`, which redirects there.

## Testing

`npm run test:carriers:live -- carriers/eparcel-kr`, with `EPARCEL_KR_TRACKING_NUMBER` and
optionally `EPARCEL_KR_UNKNOWN_NUMBER` set outside the repository.
