# Messenger

Messenger is a Czech courier delivering within Prague, Brno and Bratislava, between towns and
abroad. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.messenger.cz/MessengerWeb/tracking/REST/trackingStatus/{number}`
   with `Origin: https://tracking.messenger.cz`, as the tracking page sends it, the number in
   capitals. It needs no account, cookie, token, key or browser. Without an `Origin` header the
   API's request filter fails with HTTP 500.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The JSON reply is one consignment: its summary, both parties' addresses and its scans. HTTP
  204 with no body is the page's "Zásilku se nám nepodařilo vyhledat", which is not found; the
  tracker gives it for every number it does not know, whatever its shape. A 403 or a firewall
  page is a challenge, and a 404 or a redirect is a moved route.
- The consignment's `trackingCode` must be the whole requested number. The page follows
  whatever number the reply gives, so a reply for another number, or a list of consignments,
  is inconclusive.

## Notes

- The reply's shape comes from the fields the tracking page reads. No public number gave a
  found reply, so the clock encoding has not been seen: the parser takes epoch milliseconds,
  clocks with an offset, and wall clocks without one, which it reads in Czech time. A scan whose
  text names Bratislava or Slovakia is read in Slovak time, which keeps the same offset. Any
  other clock is a changed reply.
- Scans carry a date and a text, with no state code. A text that opens with a state of
  Messenger's API documentation keeps that name, which stages the scan; the documentation says
  what follows a state names who took or handed over the parcel, so it is dropped. Other text
  loses bracketed details and phone numbers.
- The consignment's `state` settles a delivery or a return the scans have not reached, and
  stages a consignment without scans, which is then summary only.
- The delivery window is the expected delivery while the parcel is on its way. The pickup point
  or AlzaBox, its street and town, is kept while the parcel waits there or after it was
  collected from it. The product name is the service.
- Sender and recipient names and addresses, postcodes, cash on delivery, the phone digits for
  changing a delivery, coordinates and the courier's live position are not kept.
- No detection rule claims Messenger's numbers: eight characters are shared by many carriers.
  Preflight therefore never asks Messenger, so the adapter declares no recognition. A number
  reaches it when the caller names Messenger or pastes a tracking link.

## Limitations

- No live found reply has been seen; the scans, the state and the summary fields are read as
  the tracking page's code reads them.
- No scan locations, weight, proof of delivery or partner number.

## Numbers

Messenger's tracker asks for an eight- or fifteen-character tracking number and takes nothing
else. Archived lookups on it show eight hexadecimal characters, a layout that overlaps the
eight-digit numbers of many carriers, so no rule claims it.

## Links

`tracking.messenger.cz/{number}` opens one parcel; the tracker also reads
`tracking.messenger.cz/consignment/{number}`.

## Testing

`npm run test:carriers:live -- carriers/messenger-cz`, with `MESSENGER_CZ_TRACKING_NUMBER` and
optionally `MESSENGER_CZ_UNKNOWN_NUMBER` set outside the repository.
