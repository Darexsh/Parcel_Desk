# Redpack

Tracks Redpack guides in Mexico through the tracking service of Redpack's Android app.

## How it works

Redpack's tracker on www.redpack.com.mx sends a reCAPTCHA v3 token with every search and its
server checks it, so no link opens one parcel and the adapter reads the service behind the
official app (`com.rpk.movil`) instead. On its welcome screen, before guest tracking opens, the
app signs every install in with one client and account compiled into it, through an OAuth
password grant on `api.redpack.com.mx/oauth/token`. The adapter makes the same sign-in, keeps
the bearer token for the twenty minutes it lasts and posts `[{"trackingNumber": ...}]` with it
to `api.redpack.com.mx:5400/redpack/trackingByNumber`. It signs in again once when the service
rejects the token. No cookie, browser or customer account is needed, and the service does not
check the `X-API-Key` header the app also sends.

The reply holds one guide, which must echo the whole requested number. Result code 36 ("NO SE
ENCONTRÓ LA GUÍA") is a guide Redpack does not know, and the only not found. Code 1 is a found
guide. Any other code stays inconclusive, such as 2 ("ERROR EN EJECUCIÓN DEL SERVICIO
REDPACKAPI"), which the service returns for some older guides it holds. HTTP errors, a refused
sign-in and malformed replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Redpack prints nine-digit guide numbers padded with a leading zero, and the service reads them
as integers, so the eight-digit form finds the same guide. Other inputs are invalid without a
request. Nine digits are shared with several carriers, so no detection rule claims them and
preflight does not ask this adapter.

## Notes

Scan clocks are central Mexico wall time labelled `+0000`: Redpack's tracker page labels the
same scans `-06:00`, at every branch. The adapter reads them in `America/Mexico_City` and drops
their milliseconds.

Each scan keeps its situation code and wording, in which a failed delivery or a hold names its
reason in brackets, and its branch as the location. Its shipment-control notes, which are route
and manifest references, are dropped, as are the recipient who signed, the destination's
neighbourhood and postcode, the origin postcode and the shipper's references. The service name,
the weight and dimensions of a one-parcel guide and the latest delivery day the service
promises are kept; the promised day is dropped once delivered. Rows a second parcel repeats are
dropped.

## Limitations

Redpack purges scan history: some older guides keep only their pickup, others answer not found
or with code 2. Situations no live reply showed are worded as the tracker page words them. The
reply names no branch holding a parcel for collection.

Redpack's SOAP service at `ws.redpack.com.mx/RedpackAPI_WS` (`rastreo` and the situation
catalogue) needs a customer PIN and user id. The tracker's WordPress `admin-ajax.php` action
`notify_button_click_rastreo` answers with the page's nonce and no token, but only with not
found.

## Live test

Set `REDPACK_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/redpack/adapter.live.test.ts`.
Optionally set `REDPACK_UNKNOWN_NUMBER` to check a not-found number.
