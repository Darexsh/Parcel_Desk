# DIMEX

DIMEX parcels use enabled universal providers. There is no dedicated adapter.

DIMEX (Даймэкс), founded in Rostov-on-Don in 1998, is a courier and freight network of its own offices
and franchised agents across Russia, with offices in Kazakhstan, Belarus, Armenia, Kyrgyzstan and
Estonia. Its site is dimex.ws.

## Numbers

Its waybills are eight digits, a shape several other networks print, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service with the waybill alone, without a login or CAPTCHA, and answers
a public waybill with its route. Its replies also carry a person's name that an adapter must leave
out. An adapter can follow.

## Links

Tracking links carry the waybill as `nomer` on the `otslezhivanie-nakladnyh` page at dimex.ws.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
