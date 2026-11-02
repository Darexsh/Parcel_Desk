# Moova

Moova parcels use enabled universal providers. There is no dedicated adapter.

Moova SAS, an Argentine company founded in 2018, delivers the last mile for businesses with a
network of independent couriers in Argentina, Chile, Colombia, Guatemala, Mexico, Peru and Uruguay.
Its site is moova.io.

## Numbers

Its tracker takes the shipment's id, a UUID, which carries no mark of the carrier. No public id is
known, so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON service with the id alone, without a login or CAPTCHA, which
answers an unknown id as not found. No public id has shown a known shipment's reply yet. An adapter
can follow.

## Links

Tracking links carry the id as `id` on the dashboard's `/external` page. Links with the id in the
path also carry a key that lets the recipient change the delivery, so they are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
