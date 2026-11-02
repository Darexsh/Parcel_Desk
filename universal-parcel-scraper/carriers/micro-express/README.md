# Micro Express

Micro Express is an Australian last-mile courier with depots in Melbourne and Adelaide. Tracked
through the lookup its Track Item page makes.

## How it works

1. `direct`: one `POST https://microexpress.com.au/partner/tracking-info` with the body
   `{"tracking_number":"{number}","bloclose":"true"}`, as the Track Item page sends it. It needs
   no cookie, token, key or browser, and the page's request encryption skips this call. The JSON
   reply, sent as `text/html`, has the number as sent and the scans, newest first.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with `code` 200 and an empty `tracking_log`, which the page
  reports as having no logistics information. Another `code`, such as 110 for a malformed
  request, is inconclusive. A 404 or a redirect is a moved route.
- The lookup matches the whole number, in any case. The reply only repeats the number as it was
  sent, which must be the one asked.
- Recognition makes the same request.

## Notes

- Each scan has its instant in milliseconds and the same clock as text in the zone it names,
  `Australia/Melbourne`, for Adelaide scans too. The adapter keeps the instant, in that zone, as
  the page does.
- A scan entered later can sit out of order in the reply, so scans are sorted by instant.
- The page calls a parcel delivered when its newest scan has the code `DOWN`, and in transit
  otherwise. The codes stage the scans; `tracking_status` is not read.
- The courier app words a delivery to a collection shop `Delivered by STORE`, followed by the
  shop's name, address and phone. The adapter keeps the first words only and files the scan as
  ready for pickup, and the shop's handover, `SELF-PICK`, as the delivery.
- Phone numbers and locations with digits are dropped. The reply carries no names or proof of
  delivery.

## Limitations

- No estimate, weight or service.
- The tracker has no address of its own: the single-page app opens on its About page, and the
  Track Item page reads no number from the address.

## Numbers

Micro Express numbers are `ME`, the order's creation time in milliseconds and three letters or
digits. Customer reports show them, and `micro-express-1` claims them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/micro-express`, with `MICRO_EXPRESS_TRACKING_NUMBER`
and optionally `MICRO_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
