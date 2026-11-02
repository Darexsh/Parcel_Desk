# Intel-Valley

Intel-Valley (智谷供应链, Intel-Valley Supply Chain, Shenzhen) is a Shenzhen forwarder that flies
parcels to Europe and hands them to a network in the destination country. Its site is
qhzhigu.com. The adapter reads its tracker's own lookup for numbers of IV and twelve digits.

## How it works

1. `direct`: the tracking page asks Intel-Valley's tenant of the rtb56 tracking platform, `GET
   http://oms.qhzhigu.com/webservice/Service.ashx`, without a cookie or account, and the adapter
   sends the same request as [YYpost's](../yypost/README.md), through the module the platform's
   adapters share. The host answers plain HTTP only.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

- Only the entry whose `server_hawbcode` is the whole number asked is read.
- The tracker's unknown-number answer is a not-found. Its "Parameter error" is a schema
  failure and any other refusal is inconclusive. Redirects, 404s and browser checks are never
  read as a missing parcel.
- Recognition makes the same lookup.

## Notes

- Scans keep their wall clocks, in the tracker's order, and their places date them. The
  platform's `gmt_offset` is not read: another tenant states China's offset for scans at the
  destination too, and this tenant's offsets have not been seen to follow the scan's place.
- Scans are English wording from the warehouse in Shenzhen, the air line and the
  destination's clearance, staged by the wording recorded in [statuses.json](statuses.json),
  then the shared rules. "Estimated", a month and a day, and "flights" is a flight booked
  for that day, still to come, so it is left out.
- `channel_hawbcode`, the onward network's number, becomes `delivery_tracking_number`.
- The merchant's order reference, the signatory and the proof-of-delivery link are not read.

## Limitations

- No ETA, weight, service, instant with a zone or proof of delivery.
- No public page shows a whole number, so the fixtures and the corpus sample are synthetic.

## Numbers

A universal provider files parcels of IV and twelve digits under INTEL-VALLEY, and no other
carrier's rule takes that layout. With one source and no public sample, `intel-valley-1` only
offers the number: recognition asks the tracker, which files the parcel when it knows it.

## Links

The site answers plain HTTP only, so no link opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/intel-valley`, with `INTEL_VALLEY_TRACKING_NUMBER` and
optionally `INTEL_VALLEY_UNKNOWN_NUMBER` set outside the repository.
