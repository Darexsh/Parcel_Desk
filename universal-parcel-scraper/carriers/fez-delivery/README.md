# Fez Delivery

Fez Delivery parcels use enabled universal providers. There is no dedicated adapter.

Fez Delivery is a Lagos delivery company carrying parcels door to door across Nigeria, with exports, imports
and parcel lockers. Its site is fezdelivery.co.

## Numbers

Its order numbers are twelve characters: four letters and digits, the order's creation date as day, month and
year, and two digits. `fez-delivery-1` suggests that layout at low confidence when a letter comes among the
first four; the one real public example is an archived lookup on its own tracker, and its API documentation
gives the others. It leaves out numbers that open with two or three letters followed only by digits, or with
`1G` or `ASE`, as other carriers' numbers do.

## Why there is no adapter

Its tracker reads an open JSON API without a session or CAPTCHA:
`GET customerapi.fezdelivery.co/v1/order/historyv2/{number}`. It answers the public example with the order's
history, and an unknown number with HTTP 200 and an `Error` status, so an adapter has to read the status. Its
times carry no zone, and its proof of delivery is a photo link an adapter must not show. No adapter has been
written for it yet.

## Links

The tracker opens numbers from its path, `/track-delivery/<number>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
