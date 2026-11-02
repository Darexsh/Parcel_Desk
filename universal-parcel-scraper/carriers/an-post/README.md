# An Post

Tracks S10 numbers (two letters, nine digits with a valid check digit, the issuer's country)
through the guest tracking API of the An Post Android app, `ie.anpost.app`: An Post's own,
ending `IE`, and those of mail other posts send to Ireland. It also takes the sender's
reference from the postage label, six to 35 letters and digits, which the website accepts
in the same field. No account, cookie, browser or device registration is needed. Mail from
abroad reaches An Post when a caller names it, a provider names it, or a result gives
Ireland as the destination of an S10 item.

## How it works

1. `direct`: two POST requests to the app's Azure API Management service,
   `https://apim-anpost-anpostmobileapp.anpost.com/TTServicePublic`, with JSON bodies and
   the subscription key in `Ocp-Apim-Subscription-Key`.
   - `GetItemSummary` with `{"getItemSummary":{"trackingItems":["<number>"]}}` answers the
     item's identity (`anPostNo`), its current wording and the time of that status. An
     empty list is not found, after one request.
   - Like the website, a number that is not an S10 number and that `GetItemSummary` does not
     know is asked as a sender's reference: `GetCustItemSummary` with
     `{"getCustItemSummary":{"customerNumbers":["<reference>"]}}` answers the same summary for
     the item it opens, which repeats the reference as `senderNo`. An empty list is not found.
   - `GetEvents` with `{"getEvents":{"barcodeItem":"<anPostNo>"}}` answers the history,
     newest first: activity wording, an offset-less clock, a location and a numeric
     `traceCode`. An empty history beside a bound summary is inconclusive: the summary
     repeats the newest scan, and a request An Post does not understand gets the same
     empty list, so the lookup fails as indeterminate and other sources may answer.

## Access

The subscription key is a constant compiled into the app
(`BuildConfig.TT_AUTH_HEADER_KEY`), the same for every install and read only by the app's
guest tracking client. It is included with the maintainer's approval.

## Notes

- Identity: the summary must hold exactly one item, and its `anPostNo` must be the
  requested number. Another number or a repeated item ends the lookup before the history
  is asked for. The history echoes no number, so it is only ever asked for the bound
  `anPostNo`. Asked by a reference, the item's `senderNo` must be that reference and its
  `anPostNo` a valid S10 number, which the result gives as `canonical_tracking_number`;
  a reference that opens several items is inconclusive.
- Times: every clock is a wall time without an offset, kept in `local_time`. An Post's own
  scans, which carry seconds, are also dated on `Europe/Dublin`: the universal providers'
  copies of them show the same instants. After an outbound item's dispatch abroad (code 5,
  itself dated) or from its first relayed partner scan (code 40, 49, 67 or 68, in whole
  minutes), whichever comes first, scans may keep the destination country's clock, so none
  of them is dated or reordered, An Post's own on a return included. The update instant is
  the current scan's when it is dated; a summary ahead of the history keeps its wall clock.
  No delivery estimate is invented.
- Stages map from `traceCode` through `status.ts`: the codes seen live, and the app's own
  category for each code it knows (delivered, delivery attempted, customs, received,
  sorting, in transit, return to sender). The app's sorting and in-transit categories also
  hold out-for-delivery and collection codes, so their wording may narrow them; its
  return-to-sender codes include returns still under way, which wording narrows to an
  exception. Codes neither knows take their stage, current one included, from the shared
  wording rules. A summary ahead of the history has no code; it is staged as the scan whose
  live wording it repeats, else from the shared wording rules. Aggregators relay the scans'
  sentences without their codes, and the universal providers' map stages those the same way. `statusMap` in
  [status.ts](status.ts) answers the app's review by trace code and wording; codes it does
  not know, and wording without a code, stay open.
- Code 52 names the office the item is in. The app files it under sorting, but at a post
  office it comes between a delivery to that office and a signed-for collection there, so
  there it is ready for pickup; at any other office it stays in transit. The post office is
  the scan's location when An Post gives none, and `pickup_point` while that scan is current
  or is the scan right before the current delivery, which is then the collection there.
- A delivery attempt (code 16) is reworded as the website does, "Your item was delivered"
  when its reason says DELIVERED, else "We attempted to deliver your item", and staged
  accordingly; its activity may then be empty, null or missing. A negated reason ("NOT
  DELIVERED", "UNDELIVERED") stays an attempt, where the website would call it delivered.
  The reason text is not projected.
- The summary and the history are two requests, so either may be a scan ahead. The
  current scan is the one the summary names, by clock and wording, else by clock, even
  when the service lists another first, unless the first listed scan is as late: at the
  same clock, often the same minute for relayed partner scans, the service's order
  decides. A summary at a clock no scan has, later than the first listed scan, is the
  current status itself, beside the full history; any other summary leaves the first
  listed scan current. Exact duplicate scans are removed; provider order is kept, and at
  most the first 100 scans are returned.
- The summary's recipient name, signatory, delivery office (`geisDeliveryOffice`), sender
  reference and origin country, and every scan's reason, are never projected. The sender
  reference is read only to bind a lookup by it.
- A refused key is a JSON 401 and the gateway firewall answers an HTML 403; both are
  challenges, as is any web page in place of JSON. API Management answers a spent call
  quota with a JSON 403 and `Retry-After`, which is a rate limit with that window. A 404 or
  410 is a moved route, not an unknown item.

## Limitations

- An expired item and an unknown number get the same empty summary, so both are not
  found.
- Detection does not offer An Post for a sender's reference; it is asked when a caller or
  a provider names An Post.
- Neither answer names an outbound item's destination, and the partner's relayed scans have
  no location, so the result reports no destination country.
- The website, `www.anpost.com/Post-Parcels/Track/History`, is behind Radware Bot Manager
  and turns automated sessions to a CAPTCHA. Its page calls the same service through a
  separate web gateway with a different key set in the page; it is not used.

## Testing

`npm run test:carriers:live -- carriers/an-post` sends a well-formed unknown number and
reads the confirmed public records in `numbers.json`, at least one of which must still
return a history; a malformed request would also get the empty list. Set
`AN_POST_TRACKING_NUMBER` to read a private number, or a sender's reference, as well.
