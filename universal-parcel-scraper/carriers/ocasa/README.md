# OCASA

OCASA is an Argentine logistics and courier company that delivers many Mercado Libre parcels.
OCA, the separate `oca` carrier, is a different company with its own tracker. Tracked through
its tracker's result page.

## How it works

1. `direct`: one `GET https://tracking.ocasa.com/TrackingOnline/index?airbillnumber={number}`.
   The tracker renders the shipment on the server: the number it looked up, the events newest
   first, and a panel with the origin, the recipient and the delivery address. It needs no
   cookie, token, CAPTCHA or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The tracking form and the link send the number to `Tracking/index`, which asks for a
  reCAPTCHA checkbox and then posts it to `Tracking/ValidateCaptcha`, which renders the same
  page. `TrackingOnline/index`, the address archived lookups use, renders it without the
  CAPTCHA.
- A number the tracker does not hold gets "No hay registros para mostrar." with an empty panel,
  which is the only missing shipment. The notice above a filled panel is a shipment without
  events. A redirect, a 404, a page without the timeline and a page for another number are no
  answer. The CAPTCHA step and block pages are challenges, and rate limits and other HTTP errors
  keep their own failure kinds.
- The page must show the number asked. The tracker trims and capitalizes it and pads a short
  numeric number with zeros; a part of a number finds nothing.
- Recognition makes the same request.

## Notes

- Each event has a heading, a day and a month, a clock to the minute and a sentence. The clock
  is Argentine wall time without an offset and stays `local_time`. No year is given: the newest
  event gets the latest year that puts it no later than the day after the lookup in Argentina,
  and each event below it the latest that puts it no later than a month after the one above.
  The page lists events in the order they happened, and a first scan at a centre can read
  twelve hours before the pickup listed under it, so the page's order is kept.
- An event's sentence is its description; the heading describes it only when there is no
  sentence. The sentence, then the heading, stages it through [status.ts](status.ts), and
  wording the map does not know goes to the shared wording rules. A shipment OCASA closed
  without delivering, sending the buyer to the shop, is an exception; the return follows.
- Distribution-centre sentences name a centre in brackets that is the same for every shipment
  wherever it goes. It is left out, and events have no location.
- The delivery sentence names whoever took the parcel and becomes "Entregamos el envio.".
  Sentences also lose a receiver's clause and ID and phone numbers. The panel's origin, the
  recipient's name and address and the map of the address are not kept.
- The tracker holds a Mercado Libre shipment number only when OCASA handled the shipment: its
  events are OCASA's own scans.

## Limitations

- No delivery estimate, weight, service name or proof of delivery, and no instants.
- The tracker keeps shipments for years. An event more than a year before the lookup gets a
  year too recent.
- For some numbers the page shows the notice under an empty number. That stays inconclusive.

## Numbers

OCASA's tracker answers several layouts. `EC2` or `EC3` followed by two to four letters and six
to eight digits, thirteen characters in all, appears in archived lookups, and the tracker shows
the Mercado Libre shipment behind it. No other carrier's numbers take that form, but no OCASA
page explains the code and it may come from Mercado Libre, so `ocasa-1` suggests OCASA for it
with low confidence and recognition asks the tracker. Eleven digits are Mercado Libre shipment
numbers, which other carriers deliver too and whose shape many carriers share, so no rule
claims them. Eighteen digits, a run of zeros and a shorter number, also appear on Mercado Libre
shipments, and other carriers' numeric numbers share that shape. Three letters and ten digits
starting `ECO`, `TCF` or `PST` were also looked up; `TCF` came from one merchant's shipments,
the others are unexplained, and `PST` numbers fall inside Bulgarian Posts' `PS` rule, so none
of them gets a rule. A number filed under OCASA reaches the adapter, which takes ten to twenty
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

OCASA's tracking form sends the number as `airbillnumber` to
`tracking.ocasa.com/Tracking/index`, which asks for a CAPTCHA before it shows the parcel.
Archived lookups also use `tracking.ocasa.com/TrackingOnline/index` and the former
`tracking.ocasa.com/tracking.aspx` with the same parameter.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/ocasa`, with `OCASA_TRACKING_NUMBER` and optionally
`OCASA_UNKNOWN_NUMBER` set outside the repository.
