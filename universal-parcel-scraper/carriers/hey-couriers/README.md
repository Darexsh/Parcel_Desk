# Hey Couriers

Hey Couriers parcels use enabled universal providers. There is no dedicated adapter.

Hey Couriers, in North Rocks near Sydney, delivers parcels to homes in Sydney, Melbourne, Brisbane,
Adelaide and Perth. Much of its work is the last leg for other networks, such as CouriersPlease and
DAI Post, so many parcels it delivers carry their numbers. Its site is heycouriers.com.au.

## Numbers

No public page shows one of its tracking numbers or states their layout, so there is no rule. Its
tracker looks parcels up by their label's barcode, which is often the sending network's number.

## Why there is no adapter

The tracker asks an open JSON service without a session or CAPTCHA, which answers an unknown number
with a not-found message. Its reply carries the recipient's address, which an adapter must leave
out. No public number has shown a known parcel's reply yet. An adapter can follow.

## Links

Tracking links open its tracker with the number in the `trackingNumber` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
