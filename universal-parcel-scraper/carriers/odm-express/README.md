# ODM Express

ODM Express parcels use enabled universal providers. There is no dedicated adapter.

ODM Express is a Mexican courier that carries parcels and freight to more than 250 destinations
in Mexico, in 24 to 72 hours or the same day, using the luggage holds of Omnibus de México's buses,
and sends shipments abroad. Its site is odmexpress.com.mx.

## Numbers

Its tracking page says a guide number (guía) is a letter followed by seven digits, with
placeholder examples. No public page shows a real one, and many carriers print a letter and seven
digits, so there is no rule.

## Why there is no adapter

The tracking page sends the guide number in the address of a result page on the same site, which
draws its answer on the server without a session and says when a number does not exist. No public
number has shown a known parcel's reply yet.

## Links

Tracking links carry the number as `rastreo_fall` on the result page, `/rastreo-2/`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
