# Chunil Express

Chunil Express (천일택배) is a South Korean parcel and freight carrier. Its branches collect and
deliver parcels across Korea, through terminals between them. Tracked through its tracking
page.

## How it works

1. `direct`: one `GET https://www.chunil.co.kr/HTrace/HTrace.jsp?transNo={number}`, the page
   the tracking fields on `chunilps.co.kr` and the parent company's home page open. It needs no
   cookie, token, key or browser. The server renders the parcel's details and its route, oldest
   first, in UTF-8.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with the page's own `결과가 없습니다.` answer, which is not
  found. A 404, a 410 or a redirect is a moved route.
- The page keeps the number it was sent in its search field and heads a parcel with it. Both
  must be the number asked; a page for another number is inconclusive and nothing from it is
  kept.
- The adapter sends whole eleven-digit waybills only.
- Recognition makes the same request.

## Notes

- Each scan gives a day without a time, so scans keep the day in `local_time`, with no instant
  and no `delivered_at`. The route keeps the page's order, since scans of one day cannot be
  ordered by their clocks.
- A scan's 상태 label, such as `배송완료`, is its description and stages it. The map also covers
  the trunk-line, relay and out-for-delivery labels an open-source Korean tracker lists for this
  page.
- The parcel's delivery result repeats the delivery. A delivery there settles a parcel whose
  route lacks it, and the result stands in for an empty route.
- The sender's, recipient's and signer's masked names, the goods, the parcel count, the sending
  and arrival branches and every branch's phone number are not kept.

## Limitations

- No time of day, estimate, weight or service.
- The page can open another carrier's tracker for a parcel Chunil hands over; the adapter does
  not follow it.

## Numbers

Chunil Express prints eleven-digit waybill numbers; its own tracking form accepts only eleven
digits. Other carriers print the same digit runs, so no rule claims them and preflight does not
ask the adapter. The archived public sample's tracker names its sender and recipient, masked,
so [`numbers.json`](numbers.json) holds an invented number.

## Links

`chunil.co.kr/HTrace/HTrace.jsp?transNo={number}` shows one parcel. A tracking field on
`chunilps.co.kr` and on the parent company's home page opens it.

## Testing

`npm run test:carriers:live -- carriers/chunil`, with `CHUNIL_TRACKING_NUMBER` and optionally
`CHUNIL_UNKNOWN_NUMBER` set outside the repository.
