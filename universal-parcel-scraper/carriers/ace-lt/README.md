# ACE Logistics Lithuania

ACE Logistics Lithuania parcels use enabled universal providers. There is no dedicated adapter.

ACE Logistics is a Baltic road groupage forwarder. This is its Lithuanian office; the
[Latvian one](../ace-lv/README.md) is a separate network. Its site is acelogistics.eu.

## Numbers

Its references are short runs of digits that many carriers share, and no public one has been
found, so there is no rule.

## Why there is no adapter

Its tracker answers a plain address without a session, but it reads each office's own records,
so it needs the office (`LT`) with the reference, and no public reference has been found to
check a reply with.

## Links

The tracker opens a reference from its `ref` parameter, with `office=LT`; the library reads
only addresses for this office.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
