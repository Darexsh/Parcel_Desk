# Evropat

Evropat is a Bulgarian courier delivering between its offices and to addresses across Bulgaria.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://evropat.bg/wp-json/evropat/v1/track` with `{"barcode": number}`,
   as the script of `evropat.bg/track/` sends it. The page sends it without a cookie or nonce,
   and so does the adapter; it needs no key, account or browser. The site queries Evropat's own
   service and answers with `ok` and the waybill's steps, oldest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown waybill is HTTP 404 with the page's "no shipment with this number" message. A
  number the lookup refuses is HTTP 400 with its own message, read as invalid input.
- A 404 or 400 without those messages is a moved or broken service, a 403 or a bot check's page
  is a challenge, and a reply that is not a waybill is a changed schema.
- A waybill without steps, which the page reports as having no information yet, has no history
  yet: it is neither found nor missing.
- Every step must name the waybill asked.

## Notes

- A step has a state name, a clock written `YYYY-MM-DD HH:mm:ss` and additional information.
  The clocks follow couriers' working hours in Sofia, so they are read on Sofia time. A clock in
  the hour the autumn change repeats, or the spring change skips, stays `local_time`.
- The lookup sends no code: the status map reads the whole state name.
- Steps at an office name it in their additional information: taken into its depot, loaded on
  a line from it, unloaded at it, grouped or taken out of a group there. That office is the
  step's location.
- The courier steps name the courier, and the delivery names whoever signed and may add a note.
  None of that is kept, nor the line a parcel travels on.
- The newest step with a known state decides the current stage, and the delivery's clock is the
  delivery time.

## Limitations

- No delivery estimate, weight, sender or recipient.
- Places are offices only; the courier and delivery steps have none.

## Numbers

Evropat waybills are ten digits starting with 91, as the tracking page's example and an
open-source tracker built on Evropat's service show. No rule claims them: DHL Express and other
carriers print ten-digit numbers, and some Evropat numbers pass the DHL Express check, so
recognition does not ask Evropat. The adapter sends eight to fourteen digits, the bounds the
tracking page enforces, and refuses anything else without a request. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking page opens one parcel from its `barcode` parameter, and its script also reads
`track`. Both are read as links.

## Testing

`npm run test:carriers:live -- carriers/evropat`, with `EVROPAT_TRACKING_NUMBER` and optionally
`EVROPAT_UNKNOWN_NUMBER` set outside the repository.
