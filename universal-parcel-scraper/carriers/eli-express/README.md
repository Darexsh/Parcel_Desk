# Eli Express

Eli Express parcels use enabled universal providers. There is no dedicated adapter.

Eli Express (Eli Uluslararası Taşımacılık ve Turizm Ticaret Ltd. Şti.), in Istanbul since 2013, is
an IATA cargo agent. It sends international courier shipments and freight to and from Turkey, clears
online orders through customs and packs them in its warehouses. Its site is eliexpress.com.tr.

## Numbers

Its API documentation gives tracking numbers as ELI, thirteen digits and a letter. No public number
exists yet, so there is no rule. Its bookings also get the tracking number of the carrier that
delivers the last leg.

## Why there is no adapter

The tracking page asks the site's own JSON service without a session or CAPTCHA, but no public
number is known to check its replies with. The integration API for business customers needs an
account.

## Links

Tracking links carry the number as `id` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
