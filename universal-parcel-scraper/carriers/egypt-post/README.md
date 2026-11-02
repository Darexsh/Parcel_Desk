# Egypt Post

Tracks Egypt Post items, its own and the S10 items of other posts, through the lookup its
Android app and tracking page make.

## How it works

1. `direct`: one `GET https://egyptpost.gov.eg/en-us/TrackTrace/GetShipmentDetails?barcode={number}`,
   as the app and the page send it. It needs no account, cookie, token, key or browser. `en-us`
   gives English wording.
2. `retry`: a lookup that fails to reach Egypt Post, or hangs, is sent once more within the
   budget. The server sometimes holds a reply for many seconds, known code or not, while the
   next request answers at once, so the first try gets half of the budget.

- Cloudflare in front of the site blocks Node's own HTTP client and challenges datacenter
  networks, but lets the app's client through. The adapter sends the app's User-Agent,
  `Dart/3.9 (dart:io)`. A 403 or a Cloudflare page is a challenge.
- The reply's `case` 1 holds the item's five steps; 2 is the page's "no tracking data", which is
  not found; 3 is its "incorrect number", which is invalid input. A reply with `success` false
  or no reply is inconclusive. A 404 or a redirect is a moved route.
- The reply must echo the whole requested code. Recognition makes the same request.

## Notes

- The five steps are registration, shipping, transport and processing, delivery and completion.
  Each holds only the newest scan the item had in it, so the history is always truncated.
- Mail from abroad shows from its arrival at Egypt's office of exchange. An item sent abroad can
  show the other post's arrival and delivery scans.
- A step's date and time are the scanning office's wall clock to the minute, with no zone. For an
  item scanned abroad that office is in the other country, so the clocks stay `local_time`.
- A scan's location is its office, town and country, each once; a scan abroad often names only
  its country.
- Each scan comes with a step summary, such as `In international Process`, that the page does not
  show. The adapter maps the scan's own wording, passes unknown wording to the shared rules and
  stages a scan neither knows by its summary. A round that brought the item back to the office is
  a failed attempt.

## Limitations

- The lookup has no ETA, weight, service or recipient.
- The server answers any thirteen-character code, without checking an S10 check digit. The
  adapter takes only codes with a valid check digit.

## Numbers

The adapter takes S10 item codes from any post with a valid check digit, and Egypt Post's domestic
codes of three letters, eight digits and `EG`; anything else is invalid without a request.

A code ending `EG` is Egypt Post's, but the issuer of an S10 code does not establish who delivers
it, so detection keeps such codes with the generic postal carrier. `egypt-post-s10`, at low
confidence, makes preflight ask Egypt Post about them. The tracker's own script shows the `ENO`,
`EXP` and `RCC` domestic prefixes, and `egypt-post-1` suggests Egypt Post for those at low
confidence. A longer placeholder in the script, with nine digits, is not claimed. Mail from abroad
reaches Egypt Post when a caller names it, a provider names it, or a result gives Egypt as the
destination of an S10 item. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking field on `egyptpost.gov.eg` hands the numbers to its Track and Trace page through
the browser's storage, so no address opens one parcel there. The earlier tracker on
`egyptpost.org`, which now redirects to the new site, read them from `itemReference` on
`/track-details`.

## Testing

`npm run test:carriers:live -- carriers/egypt-post`, with `EGYPT_POST_TRACKING_NUMBER` set
outside the repository. Optionally set `EGYPT_POST_INBOUND_NUMBER` to check mail from abroad and
`EGYPT_POST_UNKNOWN_NUMBER` to check a code the tracker does not know.
