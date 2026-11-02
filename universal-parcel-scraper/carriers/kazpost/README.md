# Kazpost

Tracks Kazpost items through the tracking API its page on post.kz reads.

## How it works

1. `direct`: `GET https://post.kz/external-api/tracking/api/v2/{number}` for the item's summary
   and `GET .../{number}/events` for its scans, sent together in Russian. They need no account,
   cookie, token, key or browser. Either reply can take seconds longer than usual.
2. `retry`: a lookup that fails to reach the API, hangs or meets a gateway timeout (502 or 504)
   is sent once more within the budget. The first try gets half of the budget.

- The API's notice that it has no information on the requested number, which it writes in the
  request's language, Russian unless Kazakh or English is asked for, is not found. Another
  notice is inconclusive, and so is a history that does not know an item its summary knows.
  A 403 or a block page is a challenge, even with HTTP 200. A 404 or a redirect is a moved
  route, and a reply that is not JSON is a schema error.
- Both replies must carry the whole requested code. Recognition makes the same requests.

## Notes

- A scan carries a code; the page words it from its dictionary at
  `post.kz/static/new_mappings.json` and its Russian translations, and the adapter maps the code.
  A code the dictionary does not word shows as itself, without a stage.
- The dictionary hides bag, list, act and customs register scans. The adapter drops them too.
- A code ending `_UNDO` corrects an earlier scan. The adapter cancels the latest earlier scan of
  that code, on the same `_I` or `_O` leg when the correction names one, then drops both.
- `Delivered` means the item reached the pickup point, not that the recipient has it.
- An item whose history holds no scan the page shows answers with its summary's status and code
  alone, marked `summary_only`.
- The summary gives the weight in kilograms and the receiver's country. It also names the sender
  and receiver with their addresses, phone numbers and postcodes; the adapter drops them, and the
  postcodes of the scanning offices.
- A scan's date and time are the office's wall clock, with no zone, so the clocks stay
  `local_time`.
- The office a ready scan waits at is the pickup point, and stays so for an item collected there.

## Limitations

- The API has no ETA, service name or delivery instant with a zone.
- Older items drop out of the tracker's records and then read as not found.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Kazpost prints UPU S10 numbers ending in `KZ`. Archived lookups on post.kz show Kazpost items
starting `EL` and `GH`, and customers quote `RR` registered items. The adapter takes S10 codes
from any post with a valid check digit, which the API looks up as it does Kazpost's own;
anything else is invalid without a request.

A code ending `KZ` is Kazpost's, but the issuer of an S10 code does not establish who delivers
it, so detection keeps such codes with the generic postal carrier. `kazpost-s10`, at low
confidence, makes preflight ask Kazpost about them. Mail from abroad reaches Kazpost when a caller
or a provider names it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

post.kz opens one parcel at `/services/postal/{number}`. Older lookups opened it at
`/mail/search/track/{number}/detail`, or without `/detail`; that route now shows the page's
not-found view. The former tracker at track.kazpost.kz sends visitors to post.kz.

## Testing

`npm run test:carriers:live -- carriers/kazpost`, with `KAZPOST_TRACKING_NUMBER` set outside the
repository. Optionally set `KAZPOST_INBOUND_NUMBER` to check mail from abroad and
`KAZPOST_UNKNOWN_NUMBER` to check a code the tracker does not know.
