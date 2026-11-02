# Pósturinn

Tracks Pósturinn items, its own and the S10 items other posts send to Iceland, through the lookup
its tracking page makes.

## How it works

1. `direct`: one `GET https://api.mobiz.posturinn.is/api/v1/shipments/{number}` with
   `X-Preferred-Language: en`, as the English tracking page sends it. It needs no account,
   cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The JSON reply has the shipment's summary and its scans, oldest first. HTTP 204 with no body
  is the page's "Tracking number not recognized", which is not found. A 400 whose `errorType`
  is `InvalidArgument` is the tracker calling the code invalid. A 403 or a firewall page is a
  challenge. A 404 or a redirect is a moved route.
- The shipment's `id` must be the whole requested code. A reply listing several parcels instead
  is inconclusive.
- Recognition makes the same request.

## Notes

- Each scan's `timestamp` carries `+00:00`, which the page strips before showing the clock. The
  sending post's scans on mail from abroad keep that country's wall clock under the same label.
  Iceland keeps UTC all year, so the scans of a domestic parcel, and Pósturinn's own scans of
  mail from abroad, are dated there. The sending post's scans, unknown wordings on mail from
  abroad and every scan of an item leaving Iceland stay `local_time`.
- Only the rows the page ticks off, `Historic`, are scans; `Current` and `Future` rows are
  steps still to come.
- The wording sets a scan's stage. English replies leave some wordings in Icelandic, so the map
  holds both languages. Notices, such as the text telling the recipient where the parcel is,
  move nothing. `Delivery booked` is the handover, usually recorded twice.
- The shipment's `status` settles a delivery, a return, a parcel waiting for collection, out
  for delivery or after a missed home delivery, unless the scans already reached a delivery or
  a return. Its other values trail the scans.
- The estimate is the calendar day in the shipment's Icelandic estimate sentence, kept while
  the reply counts days still to go. The service is the English label of the shipment.

## Limitations

- No weight, origin, pickup point, recipient or proof of delivery.
- Older items drop out of the tracker's records and then read as not found.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Pósturinn's items carry UPU S10 numbers ending `IS`, domestic parcels included. The tracker
also follows mail from abroad under the number the sending post issued, and answers 204 for an
item that is not bound for Iceland. The adapter takes S10 codes from any post with a valid
check digit; anything else is invalid without a request.

A code ending `IS` is Pósturinn's, but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier. `posturinn-s10`, at
low confidence, makes preflight ask Pósturinn about them. Mail from abroad keeps the suffix of
the post that issued it, and reaches Pósturinn when a caller names it, a provider names it, or
a result gives Iceland as the destination of an S10 item. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page reads the number from `q`, which the home page's search box sets, or from
`TrackingNumber`, which older lookups used.
`posturinn.is/einstaklingar/mottaka/fylgstu-med-sendingunni-thinni/?q={number}` opens one item;
the former Icelandic path and the English pages take the same parameters.

## Testing

`npm run test:carriers:live -- carriers/posturinn`, with `POSTURINN_TRACKING_NUMBER` set outside
the repository. Optionally set `POSTURINN_INBOUND_NUMBER` to check mail from abroad and
`POSTURINN_UNKNOWN_NUMBER` to check a code the tracker does not know.
