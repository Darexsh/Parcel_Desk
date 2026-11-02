# ZR Express

ZR Express delivers online shops' parcels across Algeria and collects their cash on delivery.
Tracked through the lookup its tracking page makes while it renders.

## How it works

1. `direct`: one `GET https://www.zrexpress.net/suivi?tn={number}` with `RSC: 1`, which asks the
   Next.js page for its React Server Components instead of HTML. It needs no cookie, token, key
   or browser. The reply holds an answer box with a state chip and the number asked, then the
   history, each step keyed by its UTC instant, its state code and its place in the list.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown number is HTTP 200 with the chip "INTROUVABLE" and "Aucun colis ne correspond à ce
  numéro". A number that does not fit the layout gets "INVALID"; the adapter checks the layout
  first, so it does not send one.
- The number under the chip must be the whole number asked. A redirect, a 404, or Next's
  not-found or redirect row in place of the box is a moved page.
- Recognition makes the same request.

## Notes

- The page shows each step's clock in UTC, the instant in its key, so every event keeps that
  instant.
- "Confirmé au bureau" marks each check-in at an office: at the pickup, at the destination
  office, and when a delivery run ends back at the office. Only a check-in before anything
  moved the parcel is its acceptance; later ones are in transit.
- "En livraison" comes minutes before "Sortie en livraison", which is the courier's run, so it
  stays in transit.
- "Encaissé" is the cash collected after the delivery and "Recouvert" its payout to the shop.
  Both read as delivered, and `delivered_at` is the "Livré" step.
- The remark under a step, a scan note or an internal workflow tag, is not kept.
- The tracker needs the dashes and answers "Format invalide" without them, so the adapter adds
  them.
- The site redirects a browser in English or Arabic to its page in that language, so the
  request asks for French.
- ZR's merchant API reads parcels with each account's keys, so the adapter does not use it.

## Limitations

- No delivery estimate, weight, recipient, pickup point or proof of delivery.
- No failed attempt state: a run that ends back at the office reads as in transit until the
  next run.
- The reply names no partner, so there is no hand-off.

## Numbers

ZR Express tracking numbers are three blocks joined by dashes: two characters, six, seven or
ten letters and digits, and two characters. The tracker's script accepts that layout, its
search field gives a ten-character middle block as the example, and open-source clients of ZR's
API show six and ten. Every number seen starts with two digits and ends with `ZR`, which is
what `zr-express-1` claims, as printed with its dashes; no other carrier uses that layout. The
adapter takes that layout with or without the dashes.

## Links

The tracker's search form opens one parcel at `zrexpress.net/suivi?tn={number}`, and at
`/en/track` and `/ar/suivi` in English and Arabic. `zrexpress.dz` and `zrexpress.app` redirect
to `zrexpress.net`. Links put the dashes back, as the page finds a number only with them.

## Testing

`npm run test:carriers:live -- carriers/zr-express`, with `ZR_EXPRESS_TRACKING_NUMBER` and
optionally `ZR_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
