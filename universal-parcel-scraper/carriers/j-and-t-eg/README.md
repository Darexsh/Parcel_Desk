# J&T Express Egypt

J&T Express Egypt parcels use enabled universal providers. There is no dedicated adapter.

J&T Express Egypt is J&T Express's parcel network in Egypt, run by J&T Express Egypt LLC. J&T Express Middle East,
with `JTE` numbers, is a separate entry. Its site is jtexpress-eg.com.

## Numbers

Its waybills are `JEG` and twelve digits, the layout its tracker's script checks, which `j-and-t-eg-1` suggests at
low confidence; the only public examples are archived tracker addresses whose captures hold no result. The pieces
of a multi-piece shipment have seventeen-character numbers ending in a three-digit piece number; no rule takes
them, since customers get the master waybill.

## Why there is no adapter

Its tracker posts the number to an open JSON API without a session or CAPTCHA, but the API needs the last four
digits of the recipient's phone number and answers a wrong one as it answers an unknown number.

## Links

The tracking page opens numbers from its `waybillNo` parameter, then asks for the phone digits.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
