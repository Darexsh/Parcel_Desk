# TinyPack

TinyPack parcels use enabled universal providers. There is no dedicated adapter.

Tiny Pack, Distribuidora y Transportadora del Pacífico S.A. de C.V., based in Mazatlán and in business
since 1971, carries parcels and freight between its branches across northern and central Mexico. Its
site is tinypack.mx.

## Numbers

Its tracker takes a guía of a few letters and digits. No public guía is known, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service with the guía alone, without a login or CAPTCHA, and answers an
unknown guía with a not-found reply. No public guía has shown a known reply yet. An adapter can
follow.

## Links

Tracking links carry the guía as `codigo` on the `rastreo` page at tinypack.mx.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
