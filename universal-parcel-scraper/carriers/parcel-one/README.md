# PARCEL.ONE

PARCEL.ONE parcels use enabled universal providers. There is no dedicated adapter.

PARCEL.ONE GmbH is a German cross-border shipper for online shops. It collects parcels at its
own hub and hands them to carriers in about fifty countries.

## Numbers

Its own tracking ids are thirteen digits in its API documentation, a shape many carriers share,
so no rule names PARCEL.ONE. A parcel can also carry the delivering carrier's number.

## Tracker

The tracking page asks an open JSON interface on parcel.one for the number and, optionally, the
recipient's postcode. A found reply also carries the recipient's name and address. No public
number has been found on it, so there is no adapter yet.

## Links

The tracking page's `?trackno=` opens one number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
