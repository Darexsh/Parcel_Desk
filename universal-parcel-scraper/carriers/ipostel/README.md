# IPOSTEL

IPOSTEL parcels use enabled universal providers. There is no dedicated adapter.

IPOSTEL (Instituto Postal Telegráfico de Venezuela) is Venezuela's national post and postal
regulator, based in Caracas. Its site is ipostel.gob.ve.

## Numbers

IPOSTEL gives international items UPU S10 numbers ending `VE`. Generic postal detection handles
these numbers, so no rule for IPOSTEL claims them. Its domestic IPOSPLUS guides, whose example on
the home page is `OP`, three digits, `CP` and twelve digits, stay unclaimed.

## Why there is no adapter

The tracker on its home page relays the number through the site to a back end that answers with
a connection error, and the tracking app calls a service over plain HTTP. Its other lookup, by
national ID number, returns people's names and is not used.

## Links

The tracker looks numbers up in place, so no address names one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
