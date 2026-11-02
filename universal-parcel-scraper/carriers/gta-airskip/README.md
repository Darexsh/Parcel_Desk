# GTA AirSkip

GTA AirSkip, formerly GTA GSM, is a Mississauga air freight and e-commerce delivery company.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://tms-api.gtagsm.com/trackings/track-my-package` with the body
   `{"PageSize":1,"Page":1,"TrackingNumbers":["{number}"],"DateFilterType":0,"IncludeHistory":true}`
   and the header `x-account-key: Portal`, as the tracking page on gtaairskip.com sends them.
   `Portal` is the account name the page's configuration gives every visitor; the service
   answers without it too. It needs no cookie, token or browser. The JSON reply lists the
   shipment with its scans, oldest first.
2. `retry`: the same request once more after a network failure or a hang.

- An unknown number is HTTP 200 with an empty `Data` list, which the page reports as
  `Shipment Not Found`. A reply with `IsSuccess` false is inconclusive. A 404 or a redirect is
  a moved route.
- The shipment must name the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `EventDateTime` is a wall clock without a zone. The tracking page reads it as UTC
  and shows it in a zone the visitor picks, while GTA GSM's page before it showed it as it is.
  The scans' hours fit neither reading throughout, so they stay `local_time`.
- A scan's `StandardStatus`, an id on the page's own status list, is kept as its provider code
  and stages it. Older scans have none; their name stages them, without the reason after its
  colon, as in `Loaded on Truck: Normal Status`.
  Weather, general delay and service notices move nothing.
- The page hides scans named discard, manual or reject, and takes the shipment's standard
  status for its own unless the last scan is one it hides. The adapter does the same; without
  that status, the newest staged scan decides.
- A failed delivery or another problem adds the reason the reply's description gives, such as
  `Undelivered: Customer not available`. Older terminal scans put the town and province before
  that reason; the adapter takes them as the location. A place or reason with a digit is not
  kept.
- The shipper's and consignee's names, addresses and phone numbers, the merchant's references,
  scan coordinates and proof of delivery in the reply are not read.
- The reply has final-mile and middle-mile carrier fields, but they are empty, so no hand-off is
  reported.

## Limitations

- No delivery time as an instant, and no delivery partner or its tracking number.

## Numbers

GTA AirSkip numbers have 19 letters and digits: GRG for its Ground service or GRS for its
Select service, five digits, then eleven letters or digits, as archived lookups on its tracker
show. A low-confidence rule offers GTA AirSkip for that shape, and recognition asks the tracker.
Intelcom's tracker also returns history for one such number, so the rule does not name GTA
AirSkip on its own. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

One parcel opens on gtaairskip.com, or on the former gtagsm.com, under `/tracking/` with an
optional language prefix and the number in the `trackingid` or `tracking` parameter. The
tracker reads either parameter when the page loads, and the library reads the number from
either.

## Testing

`npm run test:carriers:live -- carriers/gta-airskip`, with `GTA_AIRSKIP_TRACKING_NUMBER` and
optionally `GTA_AIRSKIP_UNKNOWN_NUMBER` set outside the repository.
