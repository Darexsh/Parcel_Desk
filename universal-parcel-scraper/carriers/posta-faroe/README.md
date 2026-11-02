# Posta (Faroe Islands)

Tracks the items Posta handles, its own and the ones other posts send to the Faroe Islands, through
the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://odin.posta.fo/api/TrackTrace?trackTraceCode={number}&languageCode=en`,
   as the tracking page's script sends it. It needs no account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The JSON reply is the item's scans, newest first, each with a scan code, its wording, a clock
  and a place. HTTP 204 with no body is the page's "Trace & trace number was not found", which is
  not found. A 403 or a firewall page is a challenge. A 404 or a redirect is a moved route.
- The reply does not repeat the number. The adapter sends only whole S10 or 20-digit numbers.
- Each scan names the parcel of the shipment it belongs to, and the page shows each parcel apart.
  A reply with several parcels is inconclusive.
- The tracker holds only items in Posta's network, and other posts' items answer 204.
  Recognition makes the same request.

## Notes

- The wording is Faroese whatever language the lookup asks for. The scan code sets the stage:
  the codes seen with their wording, and the codes the page files under its delivered,
  attempted, return, ready-to-collect, unable-to-deliver and in-transit headings. Its "Delayed"
  and "Pay attention" headings mix customs holds with notices, and its "Cancelled" does not say
  what was cancelled, so those codes set nothing on their own. Other codes go to the shared
  wording rules.
- Each clock is a wall clock to the minute, without a zone, which the page shows as it is.
  Posta's own scans, at a Faroese place, are dated in the Faroe Islands. Scans relayed from the
  post abroad name its country first, such as `DK - ...`, and keep their wall clock, as does a
  scan without a place.

## Limitations

- No delivery estimate, service, weight, pickup point or proof of delivery.
- Older items drop out of the tracker and then read as not found.
- A shipment of several parcels under one number is not read.

## Numbers

Posta's customs help says postal items carry UPU S10 numbers, some postal items 20-digit
numbers, and DHL freight ten-digit waybills. Lookups archived from Posta's trackers carry
inbound items under their sending posts' S10 numbers, with histories that follow them through
customs in Tórshavn to delivery. The adapter takes S10 numbers from any post with a valid check
digit, and 20-digit numbers; anything else is invalid without a request.

Generic postal detection handles S10 numbers, so no Posta rule claims them and preflight does
not ask Posta about them. An item reaches the adapter when a caller or a provider names Posta,
or a result gives the Faroe Islands as the destination of an S10 item.
DHL's waybills stay with DHL, and no public 20-digit number is known. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker is a single-page app that reads the number from the last path segment, so
`posta.fo/en/private/send-receive/track-trace/{number}` opens one parcel; the Faroese and
Danish pages use `fo` and `da`. The former site took the number as `cc` on `posta.fo/search`.

## Testing

`npm run test:carriers:live -- carriers/posta-faroe`, with `POSTA_FAROE_TRACKING_NUMBER` set
outside the repository. Optionally set `POSTA_FAROE_UNKNOWN_NUMBER` to check a number the
tracker does not know.
