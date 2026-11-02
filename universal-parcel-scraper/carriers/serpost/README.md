# Serpost

Tracks the items of Serpost, Peru's national post, its own and the S10 items other posts send to
Peru, through the lookup its tracking page at serpost.com.pe makes.

## How it works

1. `direct`: one `GET https://www.serpost.com.pe/Cliente/SegumientoLinea`, which opens an
   anonymous session with an anti-forgery cookie and puts the matching token in the tracking
   form, then one `POST https://www.serpost.com.pe/Cliente/SegumientoLinea/ObtenerTracking` with
   `numeroTracking=<code>`, the cookie and the token in `X-CSRF-TOKEN`, as the page's script sends
   it. It needs no account, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more in a new
   session within the budget. The first try gets half of the budget.

- The reply is a JSON array of the item's scans, newest first. It does not echo the code, so its
  scans are those of the code asked for. An empty array is the page's "Número de envío no
  registrado en el sistema", which is not found. A 400 is a refused token or session and an
  empty body no answer; neither says anything about the item.
- A 429 is a rate limit, a 403 or a firewall or bot-check page a challenge, and a redirect or a
  404 a moved route. Recognition makes the same request.

## Notes

- The lookup matches the start of what it is sent: part of a code returns another item's scans.
  The adapter sends only whole S10 codes with a valid check digit.
- Each scan gives a clock, month first, without a zone. The tracker shows only Serpost's own
  scans, at Peruvian offices, so the adapter reads them on Lima time.
- Serpost's two event systems number their events apart, three digits in the older one and one
  or two in the newer one. The wording sets the stage. A wording the map does not know takes the
  stage the page itself gives its code when it marks the item delivered or not delivered.
- The tracker writes the office into some scans, then its address and an invitation to collect
  the item there through the office's WhatsApp number. The adapter keeps the office's name as the
  location and drops the rest. A scan's `observacion` is the page's note under it, which is
  dropped, or a map of the office, which becomes the event's point when it lies in Peru.
- The page's script shows no history for some S10 series, which it calls an economic service
  without online tracking, and rewrites a few scans for display. The adapter reads the reply's
  scans as the tracker gives them.
- Serpost hands items over in Peru only, so an item out for delivery, tried, delivered or held for
  collection gives Peru as its destination.
- The page's former script asked `webservice.serpost.com.pe/Web_Api_Seguimiento` after an
  authentication call. The current page does not use that route, and neither does the adapter.

## Limitations

- The tracker has no ETA, weight, service, origin, sender or recipient.
- Older items keep only their acceptance scan.
- Mail from abroad shows only Serpost's scans, from its arrival in Peru. Such an item was not seen
  live; the adapter reads its scans the same way.
- The page also takes numeric `61…` references. The public example is a test record, so the
  adapter takes only S10 codes with a valid check digit.

## Numbers

Serpost, Peru's national post, tracks items by their UPU S10 number: two letters, nine digits
and two letters. Items posted in Peru end in `PE`. The issuer of an S10 code does not establish
who delivers it, so detection keeps such codes with the generic postal carrier. `serpost-s10`, at
low confidence, makes preflight ask Serpost about them. Mail from abroad keeps the suffix of the
post that issued it and reaches Serpost when a caller names it, or as the hand-off for an S10 item
from abroad bound for Peru. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Serpost has no tracking address that opens a shipment; its tracking page looks the number up
from a script.

## Testing

`npm run test:carriers:live -- carriers/serpost`, with `SERPOST_TRACKING_NUMBER` set outside the
repository. Optionally set `SERPOST_INBOUND_NUMBER` to check mail from abroad delivered in Peru
and `SERPOST_UNKNOWN_NUMBER` to check a code the tracker does not know.
