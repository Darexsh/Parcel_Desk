# ecParcel

ecParcel parcels use enabled universal providers. There is no dedicated adapter.

ecParcel, a logistics service of eCommax International Pty Ltd in Mount Waverley, Victoria, stores,
packs and ships online shops' orders and takes their returns. It delivers locally with its own
drivers and hands other parcels to partner couriers. Its site is ec-parcel.com.

## Numbers

No public page shows one of its tracking numbers or states their layout, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session or CAPTCHA, which answers an unknown number
with a not-found error. No public number has shown a known parcel's reply yet. An adapter can
follow.

## Links

Tracking links open its tracker with the number in the `trackingNumber` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
