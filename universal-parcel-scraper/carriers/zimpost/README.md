# Zimpost

Zimpost parcels use enabled universal providers. There is no dedicated adapter.

Zimpost (Zimbabwe Posts) is Zimbabwe's designated postal operator. Its site is zimpost.co.zw.

## Numbers

Its items carry UPU S10 numbers ending `ZW`, which postal detection reads. No public page shows one, so there is no
rule of its own. Its tracker also finds items other posts send to Zimbabwe, such as the German parcel it offers as
an example.

## Why there is no adapter

Its tracker reads an open JSON endpoint, `GET /api/track` on www.zimpost.co.zw with the number in `number`, without
a session or CAPTCHA. It answers from the UPU's IPS data with the item's scans, in UTC with each scan's offset in
hours, and finds the example parcel. An unknown number gets HTTP 404 with a JSON error, which an adapter must read
as not found rather than as an outage. No adapter has been written for it yet.

## Links

Its tracker opens in an overlay on the home page with no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
