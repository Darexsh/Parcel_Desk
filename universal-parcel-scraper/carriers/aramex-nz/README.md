# Aramex New Zealand

Tracks parcels of Aramex New Zealand, the courier network formerly called Fastway Couriers, through
the service its tracking page asks. It is Aramex Australia's tracker on its own host and database:
each host answers only its own labels, so `aramex-au` and `aramex-nz` stay separate carriers that
share their parser and tracker.

## How it works

The adapter sends one GET to `www.aramex.co.nz/umbraco/api/TrackingApi/GetTrackingData` with the
label as `LabelNo`, the request the tracking page's own script makes. It needs no account, key,
cookie, CAPTCHA or browser. A request that fails to reach Aramex is sent once more within the
budget.

The reply has the same shape as Aramex Australia's and is read by its parser
([parser.ts](../aramex-au/parser.ts)) with New Zealand's rules. It counts only when its label is
the number asked for. A number without scans gets an error naming it, and only that error is a
missing parcel; any other error, HTTP 404 and a parcel without scans stay inconclusive. Block
pages are challenges, and rate limits and other HTTP errors keep their own failure kinds.
Recognition uses the same lookup.

## Numbers

A label is two letters and ten digits; some start with a letter and a digit, or a digit and a
letter. The adapter takes those forms and refuses anything else without a request. The tracker
does not find a parcel by its SSCC. `aramex-nz-1` offers the labels with two letters and
`aramex-nz-2` those with a digit and a letter, at low confidence beside Aramex Australia and the
other carriers whose rules take twelve characters, so recognition asks both Aramex networks. The
`MX` series is New Zealand's own: archived replies of this tracker hold many such labels and
those of Australia's tracker none, so `aramex-nz-mx` names Aramex New Zealand for them at high
confidence. A label with a letter and a digit shares its shape with other networks, so detection
does not offer it.

## Notes

- Scans carry New Zealand wall clocks that follow daylight saving time: archived summer replies
  hold scans later than the service's own clock for the depot, which stays on UTC+12. The
  adapter reads them in `Pacific/Auckland`, the first reading of the hour the clocks go back.
  When the reply does not say the journey stays in New Zealand, scans stay local times.
- The page shows every scan, without a place for those before pickup. A courier's run is named
  after its area and numbered, `<area> Zone <n>`; the area is the place.
- A scan's heading decides its stage in [status.ts](status.ts). For a heading the map does not
  know, the page script's groups of codes decide, then the shared wording rules. The script's
  group of scans before pickup also holds a parcel's leg abroad, and `DVR` counts both as
  delivered and as handed on, so those codes are left to their wording. A rural freight partner's
  scan counts as onboard for delivery, as on the page.
- The estimate is the day the page shows: only between pickup and the delivering courier's round,
  with both depots known, and while that day has not passed at the pickup depot. The page names
  no Priority or Economy service.
- A parcel Aramex hands on to NZ Post for a rural delivery names NZ Post as its delivery partner,
  with NZ Post's label, when the reply flags the hand-on and NZ Post's detection takes the label
  whole. The parcel keeps Aramex's own scans and status.
- The scans' explanations, the couriers' ids, the signatory, the signature and delivery photo,
  the delivery instructions, the sender's reference and the collection point's details are never
  read.

## Limitations

Labels with a letter and a digit reach the adapter only when the carrier is chosen.

## Links

The link opens the tracking page with the label, `aramex.co.nz/tools/track?l=<label>`. Pasted
links on aramex.co.nz and on fastway.co.nz, Fastway's old host, which redirects there, are read
too. A partner link to Aramex New Zealand's home page names the carrier.

## Live test

Set `ARAMEX_NZ_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/aramex-nz/adapter.live.test.ts`.
Optionally set `ARAMEX_NZ_UNKNOWN_NUMBER` to check a label Aramex New Zealand does not know, and
`ARAMEX_NZ_ONFORWARDED_NUMBER` to check a parcel handed on to NZ Post.
