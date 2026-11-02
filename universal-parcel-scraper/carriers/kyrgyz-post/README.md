# Kyrgyz Post

Tracks the S10 items Kyrgyz Post handles, mail from abroad and its own, through the lookup its
tracking page makes.

## How it works

1. `direct`: one `POST https://post.kg/wp-admin/admin-ajax.php` with the form body
   `action=get_track_number&barcode={number}`, as the
   [tracking page](https://post.kg/language/ru/treking-posylok/)'s script sends it. It needs no
   cookie, token, key or browser.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more within the
   budget. The first gets half of the budget.

- The reply is a JSON list of scans, oldest first, each with `EventName` and `date`. It does not
  name the item: the request holds the whole code, and the tracker matches only whole codes. An
  empty list is the page's "not found".
- A reply that is not JSON or not a list is a schema error, and a block page, even with HTTP 200,
  a challenge. WordPress's `0` with HTTP 400, a 404, a 410 or a redirect is a moved route, a 429
  a rate limit. Recognition makes the same request.

## Notes

- The page also runs Google's invisible reCAPTCHA and sends its token to a separate check. The
  lookup carries no token and the page does not wait for that check, so the adapter makes only
  the lookup.
- Mail from abroad starts with the sending post's scans, relayed with the UPU's IPS event names
  in Russian and `Офис:` and the office after them. The office becomes the scan's place. Kyrgyz
  Post's own scans are Russian sentences that end with the office, such as `Поступило в
  отделение связи …`, and stay whole.
- A scan's `date` is a wall clock with no zone. The relayed scans keep the sending post's clock,
  so every clock stays `local_time`, cut to the second.
- The wording sets the stage, read up to the office. Unknown wording, and any naming customs, goes
  to the shared rules. The delivery scan keeps its own two words and nothing after them.
- Office postcodes in the wording are dropped.

## Limitations

- The page follows mail from abroad to its delivery, and items posted in Kyrgyzstan until they
  leave the country.
- Older items drop out of the tracker's records and then read as not found.
- The tracker has no ETA, weight, service, origin, destination, recipient or delivery instant.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Kyrgyz Post handles UPU S10 numbers; items it sends end in `KG`. Its tracking page gives an
inbound Singapore Post item as its example. Generic postal detection keeps S10 numbers, and a
code ending `KG` only suggests Kyrgyz Post, which recognition asks first. An S10 item from abroad
bound for Kyrgyzstan is handed to Kyrgyz Post under the sending post's number. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from its field only, so no address opens one item. The
former tracker on kyrgyzpost.kg read the number from the `searchword` parameter of
`/ru/zip-search.html`.

## Testing

`npm run test:carriers:live -- carriers/kyrgyz-post`, with `KYRGYZ_POST_TRACKING_NUMBER` set
outside the repository. Optionally set `KYRGYZ_POST_OUTBOUND_NUMBER` to check an item posted in
Kyrgyzstan and `KYRGYZ_POST_UNKNOWN_NUMBER` to check a code the tracker does not hold.
