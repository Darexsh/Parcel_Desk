# FámaFutár

FámaFutár parcels use enabled universal providers. There is no dedicated adapter.

Fáma First Kft. runs FámaFutár, a Hungarian courier with 24- and 48-hour domestic delivery and a
service to twelve EU countries. Its site is famafutar.hu.

## Numbers

A parcel id is twenty-four digits, as its tracking page and terms say. Several carriers share
the length and no public id is known, so no rule names FámaFutár.

## Why there is no adapter

The tracker's lookup answers without a CAPTCHA, but no public parcel id has been found to check
it with. The same address also takes requests that change a shipment, which an adapter must
never send.

## Links

The tracking page reads the parcel id from the fragment of `/tracking/#<id>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
