# Cathedis

Cathedis parcels use enabled universal providers. There is no dedicated adapter.

Cathedis is a Moroccan delivery company for online shops. It delivers the next day to more than 600
towns and cities across Morocco, collects cash on delivery, and handles storage, returns and
exchanges. Its site is cathedis.ma.

## Numbers

Its tracker asks for an eleven-character number, and its example is LD and nine digits. One example
does not show how its numbers are built, and other carriers' rules read two letters and nine digits,
so there is no rule.

## Why there is no adapter

The tracker asks an open service without a login or CAPTCHA, which lists a parcel's milestones with
their city and time and answers an unknown number as not found. No public number has shown a known
parcel's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `track_number` on the shipment page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
