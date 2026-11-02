# GSI Express

GSI Express flies parcels from its warehouses in Oregon and New Jersey to Korea, clears them
through Korean customs and hands them to Korea Post for delivery. It also ships from the United
States to Japan with Sagawa and to Singapore. Tracked through its tracker's own lookup by
receipt number.

## How it works

1. `direct`: one `GET https://www.gsiexpress.com/track_pop.php?textfield={number}&track_type=invoice_no`,
   the page the tracker's invoice-number search opens. It needs no cookie, token, captcha or
   phone digits. The server renders the parcel's page as UTF-8 HTML.
2. `retry`: one more read when GSI Express cannot be reached or does not answer in time.

- An unknown number is HTTP 200 with only the notice `해당 데이타가 존재하지 않습니다`. A 404
  or a redirect is a moved route.
- The page must show the number asked as its `GSI 접수번호`. The tracker matches whole
  numbers only.
- Seven digits cannot name a carrier, so no rule claims them and recognition does not ask GSI
  Express. A number filed under GSI Express, or a link to its tracker, reaches the adapter.

## Notes

- The page gives two milestones as fields: `출고시간`, when the parcel left the US warehouse,
  and `통관완료일`, the day Korean customs cleared it. Neither has a location. The adapter
  names them `출고` and `통관완료`.
- The departure is shown in Korean time and as US Eastern time thirteen hours earlier, all
  year. One of the two is an hour out in winter and the page does not say which it derives, so
  the Korean clock stays `local_time`. The clearance is a day.
- `운송장번호` is the waybill of the domestic leg. GSI Express's Korean partners are Korea Post,
  whose domestic parcel numbers are thirteen digits from 6, and CJ Logistics, whose numbers are
  shorter. A parcel with the Korean customs row and such a number is handed to Korea Post.
  Any other single waybill is kept as `delivery_tracking_number` without a carrier.
- The page also has a flight table and a domestic section that can list Korea Post's scans.
  Their rows are not read; when the page lists any, the history is marked partial and the
  enabled universal providers are asked too.
- The master air waybill, the merchant's order number and the masked recipient and address
  are not kept.

## Limitations

- No locations, weight, delivery or estimated delivery from GSI Express itself. Delivery
  comes from Korea Post through the hand-off.
- The tracker's lookup by Korea Post number is not used. Korea Post's rule and adapter
  take those numbers, and a link to that lookup gets the universal providers.

## Numbers

Receipt numbers are seven digits, which the tracker calls the invoice number. Archived lookups
show them with their Korea Post numbers. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/gsi-express`, with `GSI_EXPRESS_TRACKING_NUMBER` and
optionally `GSI_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
