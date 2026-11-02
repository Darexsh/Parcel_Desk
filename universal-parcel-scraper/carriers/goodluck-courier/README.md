# Goodluck Courier Service

Goodluck Courier Service parcels use enabled universal providers. There is no dedicated
adapter.

Goodluck Courier Service is a domestic courier network based in Kolkata, India.

## Numbers

The tracker takes consignment numbers. A lookup archived from it shows a nine-digit number, and
complaints give eight-digit consignment numbers. Digit runs of these lengths are printed by
many other carriers, so no rule claims them.

## Links

Lookups archived from the tracker carry the number as `consignment` on `index.php`, so that
address opens one parcel and the number is read from it.

## Why there is no adapter

The tracker renders a consignment's status table for `index.php?consignment={number}` without
an account, token or captcha. It also answers numbers Goodluck never issued with other
customers' consignments, and it repeats the number asked rather than the one it found, so a
reply cannot be tied to the parcel asked about. The archived nine-digit number is no longer
found. So Goodluck Courier Service stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
