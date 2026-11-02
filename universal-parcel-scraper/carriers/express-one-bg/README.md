# Express One Bulgaria

Express One Bulgaria is a domestic and international courier owned by Austrian Post. Tracked
through the form of its English tracking page.

Express One Hungary ([express-one](../express-one/README.md)) is another Austrian Post
company under the same brand, with its own site, tracker and numbers, so it is a separate
carrier.

## How it works

1. `direct`: `GET https://expressone.bg/en/tracking` opens a session (the `PHPSESSID` cookie),
   and its hidden form carries a token for that session. The adapter then posts
   `form[bols]={number}` and the token, with the cookie, to
   `https://expressone.bg/en/tracking/{number}`, as the page's Track button does. The site
   renders the shipment into the page. It needs no key, account or browser.
2. `retry`: the whole read once more, in a new session, when it fails to reach the site or
   hangs. The first try gets half of the budget.

- A number the tracker does not know returns HTTP 200 and the page's "No results found":
  `NotFoundError`.
- A token outside the page's session returns HTTP 422 and the same notice, which says nothing
  about the number, so it is inconclusive. So is a page that opens no session.
- A bill of lading must be the one the shipment's heading names. A barcode lookup answers
  with the shipment's bill of lading and never shows the barcode, so the page must hold
  exactly one shipment, whose bill of lading becomes `canonical_tracking_number`.
- The site sends its certificate without the intermediate, Sectigo Public Server
  Authentication CA DV R36, which Node does not fetch. Over the global fetch the adapter trusts
  that intermediate, which HOMEXPRESS's [certificate.ts](../homexpress/certificate.ts) holds; a
  host's own fetcher is used as given and has to trust the chain itself.
- Recognition makes the same request.

## Notes

- A status reads "wording - office | TOWN". The wording is kept as the description and the
  office and town as the location. "Data received - shipment pending" is one wording.
- The page lists statuses newest first and sometimes repeats a row; a repeat is kept once.
- Times are wall clocks to the minute without a zone, so they stay `local_time`.
- "Finalized" closes the record after a delivery and moves nothing.
- The office a parcel waits at is a link to the office's page, which is not followed.

## Numbers

The tracker takes a shipment's bill of lading, eight digits, or a package's barcode,
twenty-four digits ending in the destination's postcode. Both are bare digit runs other
carriers share, so no rule claims them and the user picks Express One Bulgaria.

## Links

`expressone.bg/{bg|en}/tracking/{number}` opens the tracking page with the number filled in;
the visitor still presses Track.

## Limitations

- No delivery estimate, weight, service or proof of delivery.
- A lookup of several numbers at once, which the page allows, is not used.
- A certificate Express One Bulgaria takes from another intermediate is refused with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` until that one is added.

## Testing

`npm run test:carriers:live -- carriers/express-one-bg`, with `EXPRESS_ONE_BG_TRACKING_NUMBER`
and optionally `EXPRESS_ONE_BG_UNKNOWN_NUMBER` set outside the repository.
