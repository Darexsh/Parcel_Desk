# Tealca

Tealca is a Venezuelan courier. Senders bring parcels to one of its stores, which make out the
guía; its platforms carry them across the country to the destination store, which delivers
them or hands them over at its counter. Tracked through the lookup its tracking form makes.

## How it works

1. `direct`: one `POST https://www.tealca.com/wp-json/tealca-rastreo/v1/rastreo` with the form
   body `numberTracking={number}&typeTracking=0&recaptcha=`, as the form on
   `tealca.com/rastrear-envio/` sends it. It needs no cookie, token, key or browser. The JSON
   reply lists shipments with a summary status and their scans, oldest first.
2. `retry`: a read that fails to reach the site, or hangs, is sent once more inside the budget.

- An unknown guía is HTTP 200 with `result: false` and the message `Número de shipment no
  existe`, which the page shows as it comes. Any other `result: false` message is a failed
  lookup, inconclusive. A 404 or a redirect is a moved route.
- Only the shipment whose `shipment` is the whole guía asked is kept. The page itself shows
  every shipment whose number contains the one typed.
- Cloudflare sits in front of the site; a challenge page is a browser check, never a missing
  parcel.

## Notes

- The page loads Google reCAPTCHA, but its form sends the lookup without a token, and the page
  answers a `?tracking=` address with the same lookup made on the server.
- Scan clocks are `M/D/YYYY h:mm:ss AM` wall clocks with no zone, so they stay `local_time`.
- Scans have no code. Their wording stages them: the opening words name the step, then the
  store or platform. The summary `status` decides a delivery only, since code 2 covers
  everything from the origin store's dispatch to the delivery.
- Each scan's `city` and `state` repeat the origin store's, not where the scan happened, so
  scans have no location. The origin store and each scan's `description` are not kept.
- The creation scan loses the guía's number it repeats. The delivery scan names the person who
  took the parcel and an ID number; both are dropped, and so are ID card and phone numbers in
  any other wording.
- No recognition: no detection rule claims Tealca's bare digits.

## Limitations

- No location, estimate, service or weight, and no clock with an offset.
- The adapter asks for a guía, the form's default. The form's pre-guía option is not used.
- Older guías are no longer answered.

## Numbers

Tealca guías seen on its own trackers are seven or eight digits. Runs of digits this short are
printed by many carriers, so no rule claims them; the adapter takes six to twelve digits, as the
lookup fails on letters. The former tracker read the guía from the path `/tracking/guia/<number>`.

## Testing

`npm run test:carriers:live -- carriers/tealca`, with `TEALCA_TRACKING_NUMBER` and optionally
`TEALCA_UNKNOWN_NUMBER` set outside the repository.
