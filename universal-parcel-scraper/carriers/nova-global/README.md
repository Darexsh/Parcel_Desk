# Nova Global

Nova Global, formerly Nova Poshta Global and before that Nova Poshta International, is the
international arm of Nova Poshta. It carries parcels into and out of Ukraine on its own
waybills and tracker, then hands them to a partner for the last mile: Nova Poshta in Ukraine,
UPS for exports to North America. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://personal.nova.global/tracking.php` with the form fields
   `num={number}` and `lang=en`, as the tracking page's script sends them. The page adds a
   reCAPTCHA v3 token, which the tracker does not check, so the lookup needs no token, cookie,
   key or browser. The JSON reply, labelled as HTML, has the waybill's route, its other
   numbers, its delivery partner and its scans, newest first.
2. `retry`: one more try when the request fails to reach the tracker or hangs. The first try
   gets half of the budget.

- The tracker answers a number it does not know, or an old waybill it no longer keeps, with
  HTTP 200 and an empty body, which the adapter reads as not found. The page shows its generic
  error for it. A reply of `203`, which the page's script reads as not found, is read the same
  way. A 404 or a redirect is a moved route, and Cloudflare's bot check is a challenge.
- The reply echoes the number asked as `billNumber`, which must be the number asked.
- Recognition makes the same request.
- The page sends the Ukrainian site's visitors to `personal.novaposhtaglobal.ua`, which gives
  the same reply in Ukrainian whatever the language asked.

## Notes

- Each scan's `date` is a wall clock with no zone, and its `timestamp` the instant the tracker
  makes of it by reading every wall clock on Kyiv time; the page shows that instant in a zone
  the visitor picks. Scans abroad keep the scanning site's own clock, so on that reading a
  parcel reaches the United States from Germany faster than a flight could. A scan gets the
  instant only where it reads back to the wall clock in the zone of the country the scan names,
  which is Ukraine's; every other scan keeps its wall clock.
- A scan's line starts with the name of its country and a full stop, as in
  `Ukraine.Delivered`. The name becomes the scan's location and the rest its description. The
  scan's `code` stages it, the same in every language.
- `bills` lists the parcel's other numbers without saying whose each is: the sending carrier's,
  Nova Poshta's waybill and, for an export, UPS's. `partner` names the carrier that delivers.
  The adapter hands the parcel to that carrier only with the one number of its own shape.

## Limitations

- No delivery estimate, weight, service or pickup point.
- The sending carrier's number and the origin country are not kept.
- The tracker also finds Nova Poshta export waybills and `NPI` numbers, which this adapter does
  not take.

## Numbers

Nova Global's own express waybills end in NPG. Archived lookups on its tracker show two
letters, nine to sixteen digits and NPG, with NP, WB, OG and YW in front. Rule nova-global-1
claims that shape with high confidence because no other carrier ends its numbers with NPG.

## Links

One parcel opens on nova.global under `/track/` with the number in the `Tracking_ID` parameter,
after an optional language prefix. The tracker's share button builds that address, and archived
lookups on the former novaposhtaglobal.ua host use the same path. The library reads the number
from both hosts.

## Testing

`npm run test:carriers:live -- carriers/nova-global`, with `NOVA_GLOBAL_TRACKING_NUMBER` and
optionally `NOVA_GLOBAL_UNKNOWN_NUMBER` set outside the repository.
