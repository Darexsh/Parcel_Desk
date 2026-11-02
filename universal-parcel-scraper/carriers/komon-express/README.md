# Komon Express

Komon Express (可蒙国际物流) is a Shenzhen forwarder running small-parcel lines from China to the
United States, the United Kingdom, Australia, Canada and Europe, handing parcels to local carriers.
Its site is komonexpress.com. The adapter reads its tracker's own lookup for numbers of KOMON, ten
digits and YQ.

## How it works

1. `direct`: the tracking page asks Komon's tenant of the rtb56 tracking platform, `GET
   http://kmgj.rtb56.com/webservice/Service.ashx`, without a cookie or account, and the adapter
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

- Scans keep their wall clocks, in the tracker's order, and their places date them. Komon's own
  scans state China's offset, those at the destination's airport too, so `gmt_offset` is not
  read. The delivering network's scans state none.
- Komon files each milestone with a code, its own steps in its English and the delivering
  network's in that network's wording. A scan is staged by its code, as recorded in
  [statuses.json](statuses.json), then by the shared rules.
- The delivering network's scans open with their place and postcode and close with a sentence
  after an arrow that repeats both. Only the wording between them is kept.
- `channel_hawbcode`, the delivering network's number, becomes `delivery_tracking_number`.
  Nothing in the reply names that network.
- The merchant's order reference, the signatory and the proof-of-delivery link are not read.

## Limitations

No ETA, weight, service, instant with a zone or proof of delivery.

## Numbers

A buyer's question shows KOMON, ten digits and YQ, and Komon's tracker answers it. It is one
sample, so the rule is low; recognition asks the tracker, which files the parcel when it knows it.

## Links

The tracker is HTTP only, so the catalog opens no carrier page.

## Testing

`npm run test:carriers:live -- carriers/komon-express`, with `KOMON_EXPRESS_TRACKING_NUMBER` and
optionally `KOMON_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
