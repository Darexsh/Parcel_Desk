# Kyungdong Express

Kyungdong Express (경동택배), run by Kyungdong Logistics, carries parcels and bulky freight
across Korea through its branches. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://kdexp.com/service/delivery/new/ajax_basic.do?barcode={number}`,
   the lookup the script of Kyungdong's tracking page and of its home page's search box makes.
   It needs no cookie, token, key or browser. The JSON reply holds the parcel's details and its
   scans, oldest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number the tracker holds nothing for is HTTP 200 with `{"result":"fail"}` and no data.
  The page reports it as a wrong waybill or a failed lookup, and adds that waybills older than
  four months cannot be looked up, so an expired parcel and a failed lookup get the same answer.
  It is therefore inconclusive (`portal_not_found`), not a missing parcel. A 404 or a redirect is a moved route.
- The parcel's `prodCode` must be the number asked.

## Notes

- Each scan's clock is a wall clock to the second, some with a fraction of a second, with no
  zone. Every scan is at a Kyungdong branch or terminal in Korea, which keeps UTC+9 all year,
  so the clocks are read in `Asia/Seoul` and each scan gets a `time`, and a delivery a
  `delivered_at`.
- A scan's `scanType` code, such as `0007`, is its `provider_code`, and its label, such as
  `배송완료`, is the description. The map reads the label, which the page's script names for
  each scan type, then the code.
- A scan's site is usually a branch, named by its area and a number, or a terminal. A delivery
  scan names the driver there instead, and a line-haul load can name its driver, sometimes
  masked. The adapter keeps a site only when it is a branch the parcel's details name, carries
  a number or names a terminal, hub or centre, and on a delivery-leg scan only a branch the
  details name. Anything with a role in brackets or a masked name is dropped.
- The reply also carries the sender's and recipient's names, addresses and phone numbers, the
  goods, the parcel count, the branches' phone numbers and the delivery's signature files.
  None of them is kept.

## Limitations

- No delivery estimate, weight, service or pickup point.
- No history for waybills older than four months.

## Numbers

Waybill numbers have thirteen digits. The tracking field asks for the digits alone, without
the hyphens a label can print. Questions on Naver KnowledgeiN and lookups archived from
Kyungdong's own tracker show them. No check digit is known, and Korea Post and other carriers
print thirteen-digit runs too, so no rule claims them, and recognition does not ask Kyungdong.
The adapter sends thirteen digits and refuses anything else without a request. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

`kdexp.com/service/delivery/etc/delivery.do?barcode={number}` opens one parcel. Kyungdong's
notice gives it and `service/delivery/ns/delivery.do` as the replacements for the old
`basicNewDelivery.kd` and `del_search.kd` addresses, which archived lookups use. All four take
the number as `barcode`.

## Testing

`npm run test:carriers:live -- carriers/kyoungdong`, with `KYOUNGDONG_TRACKING_NUMBER` and
optionally `KYOUNGDONG_UNKNOWN_NUMBER` set outside the repository.
