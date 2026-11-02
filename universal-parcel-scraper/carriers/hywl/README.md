# Huiyi Logistics

Huiyi Logistics (深圳市汇一物流有限公司) runs cross-border lines from Shenzhen for online
sellers. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.szhywl.it.com/tracking/{number}`, as the tracking page's
   script sends it. It needs no cookie, token, key, account or browser. The JSON reply names the
   number, the label `SZHYWL`, the origin and destination countries, a summary status and the
   rows, each with a time, a place, a status code and a wording.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The service matches the number case-sensitively, in capitals: `TRK` and twelve hexadecimal
  characters, or four letters, two digits, `D`, four digits and four letters. Other shapes are
  not looked up.
- A shipment counts only when the reply names the number asked and the label `SZHYWL`.
- HTTP 404 with `tracking number not found` is the unknown-number answer. The web server's own
  404 page is a moved route, not a missing parcel, and redirects are not followed.
- Recognition makes the same request.

## Notes

- Rows carry `+00:00` and `UTC`, but the page prints their digits without converting them, and
  read as UTC most Shenzhen rows fall between 01:00 and 06:00 in Beijing; on Beijing's clock
  they all fall in the day. A row placed in China or Hong Kong, written in Chinese or naming a
  city of the line's Chinese leg, is dated on Beijing's clock. Any other keeps its wall clock
  without an offset: the destination's rows fit either UTC or local time.
  [17TRACK](../../providers/seventeentrack/README.md) keeps the `+00:00` and reads its copies of
  the rows the same way.
- The page says the company's back office creates the orders and maintains their tracks. The
  rows follow fixed milestone templates, in English or in English and Chinese; one history's rows
  all end at the same minute and second, at uneven hour steps. Repeated lookups hours apart
  return the same rows. A row dated after the read is held back, a row in China by its Beijing
  instant and any other as the reply labels it, so the status comes from the rows returned,
  never from the summary.
- A bilingual row keeps its English half, written as the English rows write it
  ("Delivered [Town]"): the Chinese half translates it and names the same place. A row whose
  Chinese half names another place or holds Latin text is kept whole.
- The status code stages each row. `Customs` rows reporting the export clearance completed put
  the parcel back in transit.
- Destination rows name the recipient's town and postcode, and the first row a town and an
  office code, in the place and inside the wording. Both keep the town only. Wording from a
  signatory on is cut.
- The reply names no delivering carrier or its number, so there is no hand-off. The page's
  17TRACK button opens 17TRACK with the same number.

## Limitations

- No delivery estimate, delivery time, weight, service, partner, sender or recipient.
- Rows outside China have no established zone; consumers read them in the catalog zone.

## Numbers

The site gives `TRK` and twelve uppercase hexadecimal characters as its example, and its
tracker answers that example as its own parcel. `hywl-1` suggests Huiyi Logistics for the
layout at low confidence, since a `TRK` prefix can come from other systems. Its tracker also
answers parcels under four letters, two digits, `D`, four digits and four letters, which
`hywl-2` suggests at low confidence: one parcel is the only evidence for that layout.

## Testing

`HYWL_TRACKING_NUMBER=... HYWL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/hywl`
