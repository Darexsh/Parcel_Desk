# HKD Express

HKD Express parcels use enabled universal providers. There is no dedicated adapter.

HKD Express (昊坤达国际物流) is a Qingdao forwarder founded in 2002 and an agent of the express
integrators, with a Sydney branch for its Australia and New Zealand line. Its site is hkdexpress.net.

## Numbers

Its site gives no number layout and no public page shows an HKD Express number, so there is no rule.

## Why there is no adapter

Its tracking page asks an open JSON endpoint, `GET www.hkdexpress.net/tracking-api/GInfo.dll` with
`MfcISAPICommand=EmsApiTrack` and the number as `cno`, without a session or CAPTCHA. An unknown
number gets `ReturnValue` -102. No public number is known to see a found reply.

## Links

The tracking page takes the number in its form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
