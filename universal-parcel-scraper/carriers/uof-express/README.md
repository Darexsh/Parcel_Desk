# UOF International

UOF International parcels use enabled universal providers. There is no dedicated adapter.

UOF International (骏佳国际), run by Shanghai Junjiayi Supply Chain Management after Shanghai
Junjia International Logistics, sends sea and air freight and online orders' small parcels from
China to Japan, clears them through Japanese customs and takes stock to Amazon's warehouses
there. Yamato and Japan Post deliver in Japan. Its site is uofexp.com.

## Numbers

Its tracker shows its own waybill number, a customs number and the number of the carrier that
delivers in Japan. No public page shows one of its numbers or states their layout, so there is no
rule.

## Why there is no adapter

The tracker asks an open service that answers in JSONP, with a hash of the request the page
computes, without a session or CAPTCHA. No public number has shown a known parcel's reply yet.
An adapter can follow.

## Links

Tracking links carry the number as `trackNumber` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
