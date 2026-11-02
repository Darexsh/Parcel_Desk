# Exline

Exline is a Kazakh express courier delivering between the country's cities. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://apiv1.exline.kz/api/v1/track/detail` with `{"orderno": number}`
   as JSON, as the tracking page sends it. It needs no account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The backend relays the tracking of MeaSoft, the courier software Exline runs on. A found order
  comes with HTTP 200: its number, current status, status history, weight and planned delivery
  day. The order must name the whole requested number.
- An unknown number comes with HTTP 502 and the error `MEASOFT_ERROR`, whose detail says
  MeaSoft's reply has no order. That is a missing parcel. Any other error, or a gateway page, is
  inconclusive. A 403 or a firewall page is a challenge. A 404 or a redirect is a moved route.
- Recognition makes the same request. No detection rule offers Exline, so preflight does not
  ask it.

## Notes

- Each scan carries a MeaSoft status code, such as `DEPARTURE`, and its Russian title, in every
  language of the page. The code sets the stage; MeaSoft's documentation lists the codes, and an
  unknown one goes to the shared wording rules. A stock check, a rescheduled day, a call that
  settled no delivery time and fulfilment picking move nothing.
- The order's current status sets its stage, as MeaSoft keeps it: an operator's correction can
  leave it behind a later scan. A status that moves nothing leaves the newest staged scan's.
- A scan's `event_time` is the wall clock of the branch that recorded it, as MeaSoft documents
  it, with no zone, so the clocks stay `local_time`. The page lists the scans newest first by
  that clock; scans in the same second keep the order MeaSoft recorded them in.
- The courier's report of a delivery, `COURIERDELIVERED`, is a delivery; a manager's
  confirmation, `COMPLETE`, follows it. A courier bringing a parcel back, `COURIERRETURN`, is a
  failed attempt.
- A scan's note is not kept: it names the branch a transfer goes to, and on the delivery the day
  and the person who took the parcel. Nor are the delivery details, the courier's name, phone
  and position, the recipient's town, postcode and instructions, the prices and payment link,
  the piece count, the delivery mode and the order's internal codes.

## Limitations

- No clock with an offset, delivery instant or proof of delivery.
- The tracker reads only orders in Exline's current system; numbers from its former waybill API
  are not found.

## Numbers

Exline's waybill numbers are ten digits, seen in its API documentation and in a customer review.
Ten-digit runs are printed by many carriers, so no rule claims them; the adapter takes only
that layout. The tracker's placeholder shows an EMU prefix, but no real number of that layout
has been seen. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The site's search action opens `exline.kz/<language>/tracking?id={number}`, which is read as a
link for the Russian, Kazakh, English and Uzbek pages.

## Testing

`npm run test:carriers:live -- carriers/exline-kz`, with `EXLINE_KZ_TRACKING_NUMBER` and
optionally `EXLINE_KZ_UNKNOWN_NUMBER` set outside the repository.
