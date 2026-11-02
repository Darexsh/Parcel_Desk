# Consegnia Logistics

Consegnia Logistics (Consegnia Logistics Corp.) is a Parañaque last-mile courier delivering brands' and online
shops' orders across the Philippines, with same-day and next-day delivery and cash on delivery; Samsung's
Philippine online store is among its clients. Its site is clc-express.com.

## How it works

1. `direct`: `GET https://clc-express.com/track-delivery`, the tracking page, which opens a session in its
   cookies and carries the session's token in its form, then `POST https://clc-express.com/track-delivery-result`
   with the token in `_token` and the number in `awb_number`, sent with those cookies and
   `X-Requested-With: XMLHttpRequest`, as the page's script does. It needs no login or CAPTCHA. Each lookup opens
   its own session.
2. `retry`: both requests once more, in a new session, when they fail to reach the tracker or hang. The first try
   gets half of the budget, so the retry fits in the rest.

- A found number gets HTTP 200 with JSON holding an HTML fragment its server renders. The fragment must show the
  whole number asked.
- A number the tracker does not hold gets HTTP 404 with `success: false` and the message "No information about
  your package", read as not found. A 404 without them is a moved route, and a redirect is too.
- HTTP 419 is a refused or expired session, a 403 or a firewall page in place of the page or the JSON is a
  challenge, and a 429 is a rate limit: the tracker allows thirty lookups a minute from one address. None of them
  is a missing parcel.
- Recognition makes the same requests.

## Notes

- Each scan is a status, with a failed delivery's reason after a colon (`Delivery Failed: COT - Courier Out of
  Time`), and a wall clock to the minute with no zone, newest first. Times stay `local_time`, and consumers read
  them on the catalog's Manila clock: the delivery clocks the tracker shows fall in the Manila evening, where UTC
  would put them in the night.
- The current stage comes from the summary's status. The map stages the statuses the tracker showed; another one
  goes to the shared English wording rules.
- `Ready for Pick-up` is a booking waiting for Consegnia's rider at the shipper, so it is registered, not a parcel
  waiting for the recipient: it is a new booking's only scan, at its booking clock.
- The summary's delivery clock is not read: the delivered scan gives it, and it names no zone either. The booking
  day dates only a shipment without scans.
- The fragment names no person, address or phone number.

## Limitations

- No places, instants, expected delivery or weight.
- Shipments copied over from its former tracker show the copy's clock on every scan; only the summary's delivery
  clock, which is not read, keeps their real date.

## Numbers

Its tracking numbers are `CLC` and nine digits, which `consegnia-1` claims at high confidence: buyers post them
in Samsung Members threads, archived lookups on its former tracker show them, and its tracker finds the recent
ones. Its tracker also takes the shop's order number, which belongs to the shop, so no rule takes it.

## Links

The tracking page opens numbers from its `awb` parameter and searches them at once. Its former tracker on
consegnialogistics.com no longer resolves, so no rule reads its links.

## Testing

`npm run test:carriers:live -- carriers/consegnia`, with `CONSEGNIA_TRACKING_NUMBER` and optionally
`CONSEGNIA_UNKNOWN_NUMBER` set outside the repository.
