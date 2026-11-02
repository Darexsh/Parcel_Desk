# UVAN

UVAN parcels use enabled universal providers. There is no dedicated adapter.

UVAN (宇环国际物流, Shenzhen Yuhuan International Logistics) is a Shenzhen forwarder founded in 2008,
running air and sea lines from China to the United States, Europe and Japan and passing parcels to
express carriers. Its former site uvan56.com is down; it works through its portal on the ITDIDA
platform, uvan.itdida.com.

## Numbers

No public page shows a UVAN number, so there is no rule.

## Why there is no adapter

The portal's platform answers `GET uvan.itdida.com/itdida-api/queryTracks?no=` with JSON, without a
session or CAPTCHA. An unknown number gets the error `单号不存在`. No public number is known to see a
found reply.

## Links

The portal's tracking page takes the number in its form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
