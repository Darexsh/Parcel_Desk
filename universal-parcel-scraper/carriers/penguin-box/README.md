# Penguin Box

Penguin Box parcels use enabled universal providers. There is no dedicated adapter.

Penguin Box s.r.o., based in Brno, runs solar-powered Penguin Box parcel lockers and partner pickup
points in Czech towns, carries parcels between them in electric vans, and handles returns for the
Genesis online shop. Its site is penguinbox.cz.

## Numbers

Penguin Box gives each shipment an ID when the sender pays, which the sender writes or prints on the
parcel. No public page shows one or states its layout, so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON service without a session, which answers an unknown ID with not
found. No public ID has shown a known parcel's reply yet. An adapter can follow.

## Links

Tracking links carry the ID as `track` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
