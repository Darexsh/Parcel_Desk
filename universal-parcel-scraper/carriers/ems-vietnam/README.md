# EMS Vietnam

EMS Vietnam (Tổng công ty Chuyển phát nhanh Bưu điện) is Vietnam Post's express company. It
runs its own tracker at ems.com.vn; `vnpost` covers the national post's own tracker. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.myems.vn/TrackAndTraceItemCode?itemcode={number}EMS&language=0`,
   as the tracking page sends it: the number with `EMS` after it, and Vietnamese wording. It
   needs no cookie, token, key or browser. The page loads reCAPTCHA but sends no token with the
   lookup, and the service asks for none. The JSON reply has the item's record, its scans oldest
   first and a delivery table.

- An unknown number is HTTP 200 with every field null, which the page reports as not found. A
  `Code` of `99` saying "Không tìm thấy" is also not found; any other code is inconclusive. A
  404 or a redirect is a moved route.
- A number the express tracker does not hold, such as a national-post parcel, gets HTTP 500
  with ASP.NET's "An error has occurred." That is inconclusive, not a missing item.
- The lookup also matches senders' references, so the record's `MAE1` must be the number
  asked. A reply with delivery rows but no record names no item and is inconclusive.
- Some numbers take the service twenty seconds or more. The single read gets the whole budget.
- Recognition makes the same request, for E-series numbers only.

## Notes

- A current scan's wording is an optional UPU event code (`EMI - `), the wording, often with
  its English in brackets, then the scanning office as `(six-digit code: office - province)`.
  The code stages a scan when it has one, otherwise the whole wording does. Older scans have no
  code or office in the wording; the office is in the position field as `code - office`.
- Each scan has a date and a second, with no zone. A scan at a Vietnamese office, by its
  six-digit code, is read in `Asia/Ho_Chi_Minh`, which has no daylight saving, and a delivery
  gives `delivered_at`. A scan without one keeps its wall clock in `local_time`.
- The customer-service line, the postman's name and phone after a handover, receivers, signers
  and phone numbers are taken out of the wording. Office addresses and phones, the sender, the
  recipient, the customer code and the sender's reference in the record are not kept.
- The delivery table and the record's summary repeat the history's delivery outcomes with the
  receiver's name and the reason for a failed attempt, so they are not read. Delivery rows dated
  in full belong to the international exchange, which the history does not hold; they mark the
  history as truncated so fallback providers can add the foreign leg.
- Cash-on-delivery steps and the routing note beside each delivery round move nothing.

## Limitations

- No estimated delivery and no service name.
- The tracker keeps about two years of history; an older item reads as not found.
- An international item's foreign leg is not read.

## Numbers

EMS Vietnam items carry UPU S10 numbers ending in VN, as in the tracking page's own examples
and archived lookups. Generic postal detection keeps them, and the national post shares the
suffix. `ems-vietnam-s10` only suggests EMS Vietnam for the E series, which recognition asks it
about first; the national post's other series never ask it. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`ems.com.vn/tra-cuu/tra-cuu-buu-gui?code={number}` opens one item on the tracking page.

## Testing

`npm run test:carriers:live -- carriers/ems-vietnam`, with `EMS_VIETNAM_TRACKING_NUMBER` and
optionally `EMS_VIETNAM_UNKNOWN_NUMBER` set outside the repository.
