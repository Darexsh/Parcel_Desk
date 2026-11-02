# Nord Wheel

Nord Wheel parcels use enabled universal providers. There is no dedicated adapter.

Nord Wheel (Норд Вил) is a Moscow groupage and air freight carrier serving Russia.

## Numbers

Its waybills are numbered НФ-0 and seven digits, the layout its tracker's script describes and
its API specification shows. The library accepts only Latin letters and digits, so the full
waybill is not recognised. The tracker also accepts the digits alone, without the prefix and
leading zeros; that short form is a bare digit run and is not claimed.

## Links

The tracker reads the number from `n` on `nordw.ru/tracking/` and writes the short form there
after a lookup. It is read as a link.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
