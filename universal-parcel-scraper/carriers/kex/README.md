# KEX Express (Thailand)

KEX Express, formerly Kerry Express (Thailand), is a domestic parcel network in Thailand. It
collects from senders and service points and delivers across the country. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://th.kex-express.com/en/track/?track={encoded}` with the body
   `{"tracking_no":"{number}"}`, as the page's search sends it. `{encoded}` is the number with
   two random 32-digit hex strings on each side, joined with `fHx8` and encoded in base64. It
   needs no cookie, token, key or browser. The reply is JSON under an HTML content type: an
   entry per number with the progress rail, the shipment and its scans, newest first.
2. `retry`: a lookup that fails to reach KEX Express, or hangs, is tried once more with the rest
   of the budget.

- The tracker reads the number from the encoded parameter. A bare number in `track` gets no
  answer.
- An unknown number is HTTP 200 with a null shipment and status code `200`, which the page shows
  as not found. An input shorter than eight or longer than twenty characters gets code `400`.
- A reply asking for the page's slider captcha (`needCaptcha`), as an object or as an error
  body, is a challenge. The page shows the captcha only when a reply asks for it.
- The page tries a 401 again and then shows nothing, so it is inconclusive. A 429 is rate
  limited, a 403 or a Cloudflare check is refused, and a 404 or a redirect is a moved route.
- The service fails for SF Express numbers it relays with HTTP 200 and
  `{"statusCode":"500",...}`, which is inconclusive.
- The entry and its shipment must echo the whole number asked.
- The page's script also names `POST /en/track/api/Shipment/tracking/{number in base64}`, which
  answers the same JSON. The adapter makes the page's own request instead.
- Recognition makes the same request.

## Notes

- Each scan's `s_datetime` is a wall clock without an offset. Thailand keeps one offset all
  year, and the tracker stamps its placeholder with the lookup's time in Bangkok, so every clock
  is read in Bangkok time.
- A scan's `s_code` stages it. Numbered codes can carry a suffix, as `105.1`; the page and the
  map read their first three digits. The courier's call to the recipient (`CAL`) moves nothing.
- The progress rail's current step files a parcel under delivered (`400`) or returned (`401`),
  as the page's filters do. Until then the due date (`edt`) is the expected delivery.
- Numbers with some selling platforms' prefixes, made-up ones included, answer before the
  parcel reaches KEX with a single `WKD` row, "Waiting to ship to KEX Express", stamped with the
  time of the lookup. The adapter drops it, so such a number has no history.
- Station and distribution-centre scans keep the facility's coordinates as their point. The
  coordinates on delivery-round scans are the courier's or the recipient's and are not kept.
- The sender's and recipient's names and phone numbers, the reference, the booking, the
  postcode, the courier, the call, the signature, the delivery photos and the cash-on-delivery
  details in the reply are not kept, nor are the origin and destination provinces or the parcel
  type. Phone numbers are taken out of wording.

## Limitations

- No weight, service name or pickup point.
- International SF Express parcels, whose history the tracker relays from SF, are not read.
- Returned parcels have not been seen beyond the rail's returned step.
- Parcels drop out of the tracker some months after delivery and then answer as unknown.

## Numbers

The tracker asks for a consignment number. Archived lookups show a letter prefix of three to
five letters, often naming the shop or account that booked the parcel, followed by nine to
eleven digits; some senders add two letters at the end. Prefixes vary by sender and the same
shapes are printed by other carriers, so no rule claims them. The adapter takes eight to twenty
letters and digits, as the tracker does. Recognition can tell a known number from an unknown
one, but without a rule offering KEX Express it is not asked; a caller names the carrier or
pastes a tracking page link. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads one or more comma-separated numbers from the `track` parameter of
`/en/track/` and `/th/track/`, on `th.kex-express.com` and on the former `th.kerryexpress.com`,
including the `v2` variant of those paths. A bare number there fills in the search box. The
page's own search writes the encoded form instead, which the library does not read.

## Testing

`npm run test:carriers:live -- carriers/kex`, with `KEX_TRACKING_NUMBER` and optionally
`KEX_UNKNOWN_NUMBER` set outside the repository.
