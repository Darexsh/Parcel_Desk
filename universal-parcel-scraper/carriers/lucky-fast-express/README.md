# Lucky Fast Express

Lucky Fast Express parcels use enabled universal providers. There is no dedicated adapter.

Lucky Fast Express (吉捷国际速递), run by Lucky Fast LLC from Lynnwood, Washington, flies personal parcels
and freight from the United States to China, clears them through customs there and hands some to
Chinese carriers for delivery. Its site is luckyfastex.com.

## Numbers

Its tracker takes its order numbers, parcel courier numbers and box numbers, and names the carrier
and number a parcel was handed to. No public page shows one of its numbers or states their layout,
so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON service of the Changyunda forwarding system it runs on, without
a login or CAPTCHA, which answers an unknown number with an error code. Its replies have fields for
the recipient's name and address. No public number has shown a known parcel's reply yet.

## Links

Tracking links carry the number as `num` on the order lookup page; `type=parcel` or `type=box` picks
another kind of number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
