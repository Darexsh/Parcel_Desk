# Horoz Lojistik

Horoz Lojistik is a Turkish logistics company that delivers furniture, appliances and other
goods for retailers to the home. Tracked through the delivery-note page of its tracker.

## How it works

1. `direct`: one `GET https://app3.horoz.com.tr/wsKurumsal/_genel/frmAtfDetay.aspx?Ptn={number}`,
   the address Horoz's links open. It needs no cookie, token, key or browser. The reply is the
   delivery note (ATF) as an HTML page: a headline status, the note's details, the masked sender
   and recipient, the products, then a table of movements, oldest first.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number gets the same page with every field empty and no movement table, read as
  not found.
- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route, and a
  firewall page is a challenge.
- The page's form posts back to the address it was opened with, so it must name the whole
  number asked.
- Recognition makes the same request.

## Notes

- Each movement is a departure (`Çıkış`) from or an arrival (`Giriş`) at a centre, which is
  kept as its location. A delivered parcel's last row is the delivery (`Teslim`).
- Movement clocks are wall clocks to the second with no zone, so they stay `local_time`.
- The headline sums the note up, so its stage leads when it has one; the delivered headline is
  mapped and others go to the shared wording rules.
- The note's expected delivery day is kept until the parcel is delivered.
- The masked names, provinces and addresses, the waybill, the products, the piece count and
  volume, the vehicle plates, the destination centres and the record clocks are not kept.

## Limitations

- No instants: the page does not say which zone its clocks are in.
- No scan codes or proof of delivery. The note's delivery-problem field has no wording on
  record, so it is not read.

## Numbers

The Horoz tracking number is fourteen digits. Recipients receive it by SMS, and complaints
sometimes write it in hyphenated groups. Archived lookups on Horoz's tracker show the same
layout. No rule claims it: many carriers print fourteen-digit numbers. The tracking page also
finds a parcel by the seller's order number with the recipient's name, which the library does
not use.

## Links

The delivery-note page on Horoz's tracker opens one parcel from its `Ptn` parameter, and it is
read as a link.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/horoz`, with `HOROZ_TRACKING_NUMBER` and optionally
`HOROZ_UNKNOWN_NUMBER` set outside the repository.
