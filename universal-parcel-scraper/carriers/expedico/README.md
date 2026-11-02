# Expedico

Expedico parcels use enabled universal providers. There is no dedicated adapter.

Expedico, run by Vinteco s.r.o. in Prague, ships e-shops' parcels to seventeen European
countries through local partner carriers under one contract. Labels come from the partner, so a
recipient usually holds the partner's number. Its site is expedico.eu.

## Numbers

Expedico's own parcel ids have 13 digits, as do many other carriers' numbers, so there is no rule.

## Why there is no adapter

The tracking page asks an open GraphQL service, without a session or CAPTCHA, which answered an
archived public parcel id with its history and named the delivering partner. It takes the
partner's number too. An adapter can follow, handing partner numbers to the partner's adapter.

## Links

Tracking links carry the number as `code` on expedico.eu.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
