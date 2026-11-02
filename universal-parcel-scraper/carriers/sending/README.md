# Sending

Tracks Sending shipments through the lookup the search page on sending.es makes.

## How it works

1. `direct`: `POST https://info.sending.es/fgts/pub/locNumSeguimiento.seam?web=S` with the
   number as `localizador`, the request the search form on `sending.es/localiza-tu-envio/`
   sends. The tracker opens a session and redirects to a page bound to it: one shipment's
   tracking, or its not-found notice. The adapter reads that page with the session's cookie. It
   needs no account, token or browser. The form carries reCAPTCHA markup, but the page loads
   no reCAPTCHA script and the form posts no token.
2. `retry`: a lookup that fails to reach the tracker, or hangs, runs once more in a new session
   within the budget. The first try gets half of the budget.

- The tracker's notice that it did not find the shipment is not found. A redirect to its
  sign-in page or without a session is inconclusive, a redirect anywhere else is a changed
  reply, and a 403 or a bot check is a challenge.
- The tracker also finds a shipment by other references, and then names that shipment. The
  page's heading must name the number asked: another shipment is inconclusive.
- Recognition makes the same lookup.

## Notes

- Scans sit under day headings with a time to the minute and no zone, so they stay wall
  clocks. Some carry midnight, which marks a scan dated to the day alone: they keep the day.
- The wordings are mapped in [status.ts](status.ts). An address the recipient corrected keeps
  the stage of the scan before it. ParcelsApp relays some scans in its own English at the
  tracker's minute; those are stored in the tracker's wording, so both copies read alike.
- The page's progress rail has a phase. Its end phases, delivered and `FALTA DEFINITIVA` for a
  parcel written off as missing, set the current status even when the scans stop earlier. Its
  other phases are coarser than the scans and are not read.
- Each scan keeps its wording and the town of the branch. The receipt row beside a delivery,
  which names whoever took the parcel, is left out, as are the sender's reference, the
  delivery shift, the sender's and recipient's postcodes and towns, the delivering branch,
  branch numbers and the delivery options.

## Limitations

- No ETA, weight, service, delivery instant with a zone or proof of delivery.
- Older shipments drop out of the tracker, which then gives its not-found notice.
- A forwarded shipment's link to its new tracking is not followed.

## Numbers

Customers quote twelve-digit shipment numbers (número de expedición or de seguimiento) in
public complaints addressed to Sending, leading zeros included. Twelve digits are shared by
many carriers and nothing in the number points to Sending, so a low rule only offers them:
recognition asks Sending about them for a lookup from a country it delivers in, Spain,
Portugal or Andorra. The adapter takes twelve digits and refuses anything else without a
request.

## Links

Sending's search page posts the number to its tracker as a form, but the tracker takes the
same `localizador` in a GET too and redirects to the shipment's page. That address is the
tracking link and the link rule.

## Testing

`npm run test:carriers:live -- carriers/sending`, with `SENDING_TRACKING_NUMBER` and optionally
`SENDING_UNKNOWN_NUMBER` set outside the repository.
