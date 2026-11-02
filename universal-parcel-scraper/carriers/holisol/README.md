# Holisol

Holisol parcels use enabled universal providers. There is no dedicated adapter.

Holisol is an Indian logistics company running warehousing and parcel delivery under its own airway bills. Its
site is holisollogistics.com.

## Numbers

Its tracker's script reads `HL` and eleven digits as its airway bills. The only public example is an archived
tracker address whose capture holds no result, so there is no rule.

## Why there is no adapter

Its tracker posts the number to an open JSON endpoint without a session or CAPTCHA, which answers `null` for an
unknown number and for the archived one alike.

## Links

The tracking page opens numbers from its `awb` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
