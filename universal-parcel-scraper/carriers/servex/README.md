# Servex

Servex parcels use enabled universal providers. There is no dedicated adapter.

Servex Global Logistics, founded in 2015 in Istanbul, with offices in Qatar and Egypt, carries air
and sea freight, handles customs and runs Servex Express for online sellers' parcels. Its site is
servex.com.tr.

## Numbers

Its tracker takes an air waybill number and gives no layout or example. No public number is known,
so there is no rule.

## Why there is no adapter

The tracker is a plain page that reads the number from its address without a session or CAPTCHA, and
flags whether it found the shipment. No public number has shown a known shipment's reply yet. An
adapter can follow.

## Links

Tracking links carry the number as `awbNumber` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
