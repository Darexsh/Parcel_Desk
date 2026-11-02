# Patuen

Patuen parcels use enabled universal providers. There is no dedicated adapter.

Patuen (派通国际物流, Paitong International) is a Guangzhou forwarder shipping online sellers' small parcels
from China to the United States on its own line, duties included, with British and Australian channels,
overseas-warehouse dropshipping and air freight. It hands last legs to posts and couriers. Its site is
patuen.com. It is not [SPT Express](../sptexp/README.md) (速派通).

## Numbers

Its tracker gives no layout or example. No public page shows a Patuen number, so there is no rule.

## Why there is no adapter

Its tracking page reads an open JSON endpoint without a session or CAPTCHA:
`POST api.patuen.com/packetTrack/getPTTrack` with the numbers, one per line, in the form field `strNumber`.
It answers an unknown number with HTTP 200, an empty `trackDetails` list and a null `logisticsInfo`. A found
parcel has its scans and a transit status. No public number is known to see a found reply.

## Links

The tracking page reads numbers from the browser's storage, not from its address, so no link names one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
