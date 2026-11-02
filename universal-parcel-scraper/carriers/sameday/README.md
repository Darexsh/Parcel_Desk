# Sameday

Tracks Sameday AWBs and their parcel numbers through the JSON service behind the tracker on
the official country sites. No key, cookie, session or browser is needed.

## Scope

Sameday runs two networks, each with its own site and API host: `sameday.ro` and
`sameday.bg`. Each host knows only its own network's shipments. The adapter asks them in that
order and keeps the first history. Romanian parcels are confirmed live. The Bulgarian host
answers the same request in the same shape and returns the same not-found reply, but no
Bulgarian history has been checked.

Sameday stopped operating in Hungary, as `sameday.hu` announces. The adapter does not ask its
host, so a failure there cannot turn the other countries' not-found into an error.

## How it works

`direct`: `GET https://api.sameday.<ro|bg>/api/public/awb/<number>/awb-history?_locale=en`,
the request the site's tracker makes, one country after another. A JSON 404 is that
country's not-found. Only a not-found from both is a missing parcel. A history from
any host is the answer even when another host failed; otherwise the first failure stands.
HTML, 403 and 429 replies and malformed JSON are never read as not found.

## Notes

- The number is checked the way the site checks it: 5 to 28 letters and digits, a leading
  `#` dropped. A number without a digit is refused before any request.
- An AWB starts with `1` and a three-character client code. Detection offers Sameday when the
  code is letters, or when it holds a digit and `LN` or `LL` follows, with nine to twelve digits
  as after a code of letters. A code of two letters and a digit is only offered as `XL`, a client
  seen on a Sameday parcel, with eleven digits: First Line and OnTrac print other two letters
  and digits that way. None of these shapes carries a check, so all stay low confidence.
- The reply holds the AWB's own history, newest first, and each parcel's scans, oldest
  first. A parcel number (the AWB and a three-digit suffix) is answered with the whole AWB:
  the adapter reads that parcel's scans and reports the AWB as `canonical_tracking_number`.
  An AWB with one parcel reads that parcel's scans, as the site shows them. An AWB with
  several reads the AWB's history.
- Clocks carry their offset. `provider_code` is the state, a slash and the status,
  `statusStateId/statusId`. The stage comes from the state. The public reply does not list
  the states; the official Android app's state enum names them, and its labels give their
  meaning.
- Redirection and postponement instructions can come before the pickup and say nothing about
  where the parcel is: they keep the stage of the scan before them. A forward movement on the
  return leg, the scan's `inReturn` flag, is filed under returned. The AWB's `isReturn` flag
  applies to its newest scan, as the site reads it. Statuses 46 (returned) and 74 (refused by
  the recipient) take their stage under any state. A state the map does not know goes to the
  shared wording rules, first with the scan's wording, then with the state's.
- `delivered_at` is the time of the newest delivery when the parcel's stage is delivered.
- `statusMap` in [status.ts](status.ts) answers the app's review queue by state. Forward
  states depend on the return flag and unlisted states on their wording, so it does not
  answer them; the instructions are gaps on purpose.
- The site replaces the wording of some scans with its own text for the scan's reason. The
  adapter keeps the reply's wording and drops the reason, the next depot (`transitLocation`)
  and the creator field.
- Pactic, a Hungarian shipping platform, books parcels on Sameday among other carriers and
  shows them on its own tracker. Its anonymous JSON, `dashboard.pactic.com/api/Meta/tracking?waybill=`,
  lists Pactic's status codes, its own hub steps among them, with dates on no stated clock, so
  the adapter reads Sameday's history instead.
- A pasted link to either country site names Sameday with the number in its `awb` parameter
  or in the `#awb=` fragment the site's tracker writes.

## Limitations

There is no estimated delivery, pickup point name or service name in the reply. The Romanian
site's result page, `sameday.ro/status-colet/?awb=<number>`, answers automated browsers with a
Cloudflare check, so the catalog links that page without a number. The home page hides its own
tracker and sends visitors there. The API hosts have no such check.

## Live test

Set `SAMEDAY_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/sameday/adapter.live.test.ts`.
Optionally set `SAMEDAY_UNKNOWN_NUMBER` to check that a number no country knows is not found.
