# Flash Express Philippines

Flash Express Philippines is a domestic parcel network in the Philippines, with its own outlets
and hubs. It runs its own site, tracker and numbers; the `flash-express` id covers Flash Express
in Thailand, whose numbers start with TH. Tracked through the lookup the Flash Express PH app
makes before anyone signs in.

## How it works

1. `direct`: one `POST https://user-api.flashexpress.ph/api/pub/v1/parcels/track_parcel_batch`
   with the body `{"pno_list":["{number}"],"pub_query":true,"show_sign_pic":false}`. It needs no
   cookie, token, key or browser. The JSON reply has one entry per number asked, which echoes it
   in `pno`, with the parcel's summary and its scans, newest first.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- The service answers HTTP 200 for every number. The entry for a number it does not know has
  nothing but the number: no state and no scans. A 404 or a redirect is a moved route.
- A `code` other than 1 is inconclusive, or a rate limit when the message says the client asks
  too often.
- The entry must echo the whole number asked.
- Recognition makes the same request.

The website's tracking page and its `/webApi/tools/tracking` lookup, the same lookup the Thai
site makes, sit behind a JavaScript browser check that answers a plain request with HTTP 200
and a check page. The app's service has no such check. A check page in its place is a
challenge, not a missing parcel.

## Notes

- Each scan's `routed_at` is Unix seconds. The tracking page shows the same scans as wall
  clocks that match these instants at +08:00, and the Philippines keeps that offset all year,
  so the adapter returns the time at +08:00.
- The scans use the `route_action` codes of Flash Express in Thailand, plus linehaul van scans
  and a pending return. The adapter shares the Thai adapter's code map, wording cleanup and
  result in [`../flash-express`](../flash-express). Some parcels' scans come without a code;
  the wording of those the tracker is known to send stages them. A courier finding no sender
  at a pickup moves nothing.
- The summary's `state` decides a delivery, a return, a problem parcel or a closure.
- A pending return or an automatic return sends the parcel back to its sender, and its scans go
  on under the same number. The scans from then on are the return leg, and their delivery is
  the return.
- The wording ends with the scan's province and town, each in 【】, which become the location
  with the town first. Sites are Flash's own codes and names inside the wording. A van scan
  worded with a dash says nothing and is left out.
- The adapter removes who signed, the sender named in the pending-return wording, the courier
  details of the older wording and phone numbers. The reply's sender and recipient names,
  origin and destination, courier names and phones, outlet phones, call list and signer are
  not kept. The adapter asks without the signature photos.

## Limitations

- No delivery estimate or weight.
- The return waybill named in the pending-return scan is not followed; the trip back is read
  from the original number's scans.

## Numbers

Archived lookups on the tracker and customer reviews show a P, four digits, six or seven
letters and digits, and a final letter. The low-confidence rule suggests Flash Express
Philippines for that layout: the single-letter prefix carries little evidence on its own, and
the twelve-character form also fits Colis Privé's generic alphanumeric rule. Recognition asks
the app's service. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`flashexpress.ph/fle/tracking?se={number}` opens one parcel. The tracker reads the same `se`
parameter under `/en/` and `/zh/` and at the former `/tracking/` address, on the bare and `www`
hosts.

## Testing

`npm run test:carriers:live -- carriers/flash-express-ph`, with
`FLASH_EXPRESS_PH_TRACKING_NUMBER` and optionally `FLASH_EXPRESS_PH_UNKNOWN_NUMBER` set outside
the repository.
