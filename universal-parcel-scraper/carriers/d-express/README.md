# D Express

D Express is a Serbian courier that delivers parcels across Serbia from regional centres, many of
them for web shops, to the door or to a parcel locker. Tracked through the lookup its tracking
page makes.

## How it works

1. `direct`: one `POST https://www.dexpress.rs/rs/pracenje-posiljaka` with `ajax=yes`,
   `task=search` and `data[package_tracking_search]={code}`, as the page's script sends the code
   it reads from its address. It needs no cookie, token, key or browser. The JSON reply, served
   as HTML, carries the code, a summary as the HTML the page shows and the scans, oldest first.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown code is `{"flag":false}` with the page's notice "Pošiljka nije pronađena.", read as
  not found. Any other refusal is inconclusive.
- The page answers every code with HTTP 200, so a 404 or a redirect is a moved route.
- The reply must name the whole code asked.
- Recognition makes the same request.

## Notes

- Scan times are wall clocks to the second with no zone. D Express delivers in Serbia only, so
  they are read in Belgrade.
- The summary's current status decides the stage: the first scans often share a second, and the
  reply's order does not say which came last.
- When the current status is the newest scan, the summary's line for where the shipment is gives
  that scan the town of the centre whose warehouse or courier holds it. Other lines say nothing
  about a place.
- A redirect to a parcel locker, chosen by the recipient on the tracking page, moves nothing and
  has no stage.
- The recipient's masked name and address, the town, the parcel count, the regional centre's
  phone, the delivery options and the fiscal receipt link in the reply are not kept.
- The adapter sends only two letters and ten digits, in capitals.

## Limitations

- No estimate, weight, service, scan codes or proof of delivery.
- Places only for the current status.

## Numbers

D Express shipment codes have two letters and ten digits, as archived lookups on its tracker
show. The letters vary by sender, and the same shape is printed by other carriers, so no rule
claims it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads the code from the last part of its address, under `/rs/pracenje-posiljaka/`
or, in English, `/en/track-and-trace/`.

## Testing

`npm run test:carriers:live -- carriers/d-express`, with `D_EXPRESS_TRACKING_NUMBER` and
optionally `D_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
