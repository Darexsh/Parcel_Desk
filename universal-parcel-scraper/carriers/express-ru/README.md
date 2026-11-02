# Express.Ru

Express.Ru parcels use enabled universal providers. There is no dedicated adapter.

Express.Ru («Экспресс Точка Ру»), a Moscow courier service founded in 2001, delivers documents and
parcels in cities across Russia through its own and franchised offices. Its site is express.ru.

## Numbers

Its tracker and API guide give orders as Web- and ten digits and waybills as WEBN and seven to ten
digits. Those suggest Express.Ru at low confidence, since no public shipment shows them yet.
Customers can also give waybills their own numbers, which no rule can know.

## Why there is no adapter

The tracker posts the number to an open JSON service, without a login or CAPTCHA, and answers an
unknown number with an empty reply. No public number has shown a known reply yet. An adapter can
follow.

## Links

The tracker has no per-shipment address, so there are no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
