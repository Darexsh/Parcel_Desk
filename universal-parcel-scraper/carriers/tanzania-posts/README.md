# Tanzania Posts Corporation

Tracks Tanzania Posts Corporation items, letters, parcels and EMS, through the lookup of its
domestic tracker, the Posta Tracking System.

## How it works

1. `direct`: one `POST https://tracking.posta.co.tz/index.php/Tracking/get_NEW_NEW_tracking_information`
   with the form body `code={number}`, as the [search page](https://tracking.posta.co.tz/index.php/Tracking/tracker)'s
   script sends it. It needs no cookie, token, key or browser. The reply is JSON after a few
   blank characters: `Success` with the result panel as HTML in `temp`, or `Error` with the
   notice the page shows in `msg`.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more within the
   budget. The first gets half of the budget.

- The panel's barcode must be the whole requested code.
- The notice "Barcode Not Found, Please try again!" is the only missing item. The notice that
  an unpaid item cannot be tracked is inconclusive, and its amount and control number are not
  kept. Another notice, a reply that is not JSON, CodeIgniter's error page, the site's page for a
  missing route or a panel without the barcode is a schema error. A block page, even with HTTP
  200, is a challenge, a 429 a rate limit, and a 404, a 410 or a redirect a moved route.
- The tracker takes a few seconds to answer, found or not, so the adapter's default budget is
  30 seconds.

## Notes

- The post's site labels this tracker domestic and sends international lookups to the UPU's
  Global Track and Trace.
- Scans are listed oldest first with the clock the tracker recorded them at, to the second. The
  clock is a 24-hour one followed by AM or PM. An item whose origin and destination are both
  Tanzanian regions is read on Dar es Salaam's clock; any other item's scans keep their wall
  clock.
- The counter scan's wording names the office, which becomes the scan's place. The other scans
  name no place: "On Transit to destination region" names where the item is going.
- The panel's status settles a delivered item, whose history has no delivery scan. Otherwise the
  newest scan sets the stage. A panel without scans is a summary.
- The panel names the sender and the addressee with their phone numbers and addresses, and who
  took delivery with their phone number and identity document. None of it is read, and neither
  are the origin, the destination's office, the item's kind and the delivery day. The weight
  and the destination's country are kept.
- Recognition is not declared: the lookup tells a known item from an unknown one, but it takes
  longer than recognition's budget, so no detection rule offers Tanzania Posts Corporation for a
  number.

## Limitations

- No ETA, service or event code, and no clock with an offset from the tracker.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Tanzania Posts Corporation's letters, parcels and EMS items carry UPU S10 numbers ending in
`TZ`. Generic postal detection handles these numbers, so no rule for Tanzania Posts
Corporation claims them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

An archived lookup passed the code as `id` on `/index.php/Tracking/dashboard_tracking_information`.
That route now shows the site's missing-page notice, so such a link only names the item.

## Testing

`npm run test:carriers:live -- carriers/tanzania-posts`, with `TANZANIA_POSTS_TRACKING_NUMBER`
and optionally `TANZANIA_POSTS_UNKNOWN_NUMBER` set outside the repository.
