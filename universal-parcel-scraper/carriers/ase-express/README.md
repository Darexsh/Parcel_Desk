# ASE Express

ASE Express parcels use enabled universal providers. There is no dedicated adapter.

ASE (Asia Africa Sky Express), trading as ASE Lojistik, is an Istanbul express carrier and OCS network member. It
carries documents and parcels between Türkiye, Russia, the Caucasus and Central Asia. Its site is ase.com.tr.

## Numbers

Archived lookups on its own tracker show eleven digits, thirteen digits, `SP` and nine digits, and, newest, `A1`
and nine digits. AJEX's current numbers and GLS Italy's depot numbers share the `A`-and-ten-digit shape, and the
other shapes are shared by other carriers too, so there is no rule.

## Why there is no adapter

Its tracker answers an open GET, `/cwb/trackshipment` on tracking.ase.com.tr with the number in `Id`, without a
session or CAPTCHA, and shows a shipment's scans on local clocks without an offset, with the signer's name. It
answers an unknown number with a notice and HTTP 200. It no longer finds the archived numbers, and no current
public number is known.

## Links

The tracker opens numbers from its `Id` parameter or from its path; older addresses put the number after `/cwb/`
or `/cwb2/` under a language code.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
