# Poste Vaticane

Poste Vaticane parcels use enabled universal providers. There is no dedicated adapter.

Poste Vaticane is the Servizio Poste e Filatelia of the Governorate of Vatican City State, which
runs the Vatican's post offices and issues its stamps. Its site is postevaticane.va.

## Numbers

Poste Vaticane gives registered items UPU S10 numbers ending `VA`. Generic postal detection
handles these numbers, so no rule for Poste Vaticane claims them.

## Why there is no adapter

Its tracker is a plain page that reads the number from its address without a session or
CAPTCHA, and says when it has no tracking for an item. No public number has shown a known item's
reply yet. An adapter can follow.

## Links

Tracking links carry the number as `trackingNumber` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
