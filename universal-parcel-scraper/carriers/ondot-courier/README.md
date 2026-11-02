# Ondot

Ondot parcels use enabled universal providers. There is no dedicated adapter.

Ondot, run by The Ondot Courier & Cargo (Global) Private Limited in New Delhi, carries documents and
parcels within India and abroad. Its site is ondotcourier.in.

## Numbers

Its tracker takes air waybill (AWB) numbers. Its example, OND and nine digits, is made up and no
public number is known, so there is no rule.

## Why there is no adapter

The tracker posts the number to an open JSON service without a session or CAPTCHA, which answers an
unknown number with not found. No public number has shown a known parcel's reply yet. An adapter can
follow.

## Links

Tracking links carry the number as `awb` on the tracking page, which looks it up when it opens.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
