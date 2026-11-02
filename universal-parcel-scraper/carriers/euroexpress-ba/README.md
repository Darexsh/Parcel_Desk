# EuroExpress

EuroExpress brza pošta is a courier in Bosnia and Herzegovina. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://app-api.euroexpress.ba/api/v1/pub/track?trackingNumber={number}`
   with `Accept: application/json`, as the tracking page on euroexpress.ba sends it. It needs no
   cookie, token, key or browser. The lookup redirects once to the route that answers on the
   same host, for the same code; the adapter follows that redirect and no other. The JSON reply
   has the shipment's summary and its scans.
2. `retry`: one more attempt after a failure to reach the tracker, inside the budget.

- An unknown code is HTTP 404 with an error naming the code asked, which the page reports as
  not in EuroExpress's system. Any other 404, or a redirect elsewhere, is a moved route.
- The shipment must carry the code asked.
- Recognition makes the same request.

## Notes

- The summary's status code stages the shipment as the progress rail in EuroExpress's app reads
  it: picked up from 0, in delivery from 2 and delivered from 20. Delivered shipments have 30.
  A code the map does not know keeps the summary's wording without a stage.
- Scans have Bosnian wording and no code, so they have no stage of their own.
- The reply writes its clocks with a UTC offset, and the page shows them in its visitor's zone,
  so a scan with an offset is kept as an instant. A clock written without one stays the wall
  clock it is, in `local_time`.
- The tracker can keep a shipment's summary without its scans. The adapter then returns the
  summary alone.
- A repeated scan is kept once, and scans listed oldest first are turned round.
- The reply names the person who took the parcel and gives its contents, value, parcel count
  and dates of sending and receipt. None of these is kept.

## Limitations

- No estimate, no service and no delivery time apart from the scans.

## Numbers

EuroExpress calls its tracking number the shipment code; it is printed on the waybill. The
manual of EuroExpress's own web shop shows a nine-digit code, and the tracker takes nine
digits. Many carriers print nine digits, so no rule claims it. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The tracker reads the code from the last part of its address,
`euroexpress.ba/pracenje-posiljke/{number}`, and looks it up on load.

## Testing

`npm run test:carriers:live -- carriers/euroexpress-ba`, with `EUROEXPRESS_BA_TRACKING_NUMBER`
and optionally `EUROEXPRESS_BA_UNKNOWN_NUMBER` set outside the repository.
