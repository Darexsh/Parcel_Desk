# Yamato Transport Singapore

Yamato Transport Singapore parcels use enabled universal providers. There is no dedicated adapter.

Yamato Transport (S) Pte. Ltd., a Yamato Holdings company, delivers parcels in Singapore and ships
them abroad, including International TA-Q-BIN to Japan, and offers moving, freight forwarding and
contract logistics. Its site is yamatosingapore.com.

## Numbers

Its numbers are Yamato's twelve-digit waybills, printed in groups of four, whose last digit is the
remainder of the first eleven divided by seven: the layout of the `yamato` entry. Yamato Transport's
rule already takes that shape, so taqbin-sg has no rule of its own. An International TA-Q-BIN parcel
keeps its number when it reaches Yamato in Japan.

## Why there is no adapter

The tracker posts the number, without dashes, as `keyTrackingNumber` to an open JSON endpoint on
dev.message.sg, `external_waybill_fetchStatusLog_yts`; message.sg also runs
[TA-Q-BIN Hong Kong](../taqbin-hk/README.md)'s tracker. Its page reads the Hong Kong rows' fields,
and also the waybill and origin numbers and whether the parcel is local. It
answers without a session or CAPTCHA with scans on the scanning site's clock, and with an empty list
both for an unknown number and for one it no longer keeps. No public number it still knows has been
found.

## Links

Tracking links carry one or more numbers, separated by commas, as `a` on the tracker's
`trackitem_custom_y.html` page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
