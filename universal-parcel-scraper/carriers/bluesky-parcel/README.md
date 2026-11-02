# BlueSky Parcel

BlueSky Parcel parcels use enabled universal providers. There is no dedicated adapter.

BlueSky Parcel, a company registered in Estonia, carries online orders into Europe as a forwarding
agent working with other carriers: it clears them through EU customs, trucks them across Europe and
hands them to local delivery partners or its own network for the last mile. Its site is
blueskyparcel.com.

## Numbers

No public page shows one of its tracking numbers or states their layout, so there is no rule.

## Why there is no adapter

The tracker takes up to 40 numbers and polls an open JSON service for each without a session or
CAPTCHA, which answers an unknown number with no scans. No public number has shown a known parcel's
reply yet. An adapter can follow.

## Links

Tracking links carry one or more numbers, separated by commas, in the path after `/tracking/`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
