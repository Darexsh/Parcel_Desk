# EMEX

EMEX parcels use enabled universal providers. There is no dedicated adapter yet.

EMEX is a Kazakh courier founded in 2004, FedEx's licensee in Kazakhstan and part of TransInvest
(Militzer & Münch). It delivers across Kazakhstan with its branches, lockers and partners. Its
site is emex.kz. It is not emex.ru or emex.ae, which sell car parts.

## Numbers

No public page shows an EMEX number, so no rule names it.

## Tracker

The tracking page asks two WordPress actions without a cookie, key or CAPTCHA: one finds the
order by its number, the other lists its scans, with UTC clocks. An archived number gets the
same answer as an unknown one, so an adapter needs a public number to tell them apart.

## Links

The tracking page opens a number from its `id` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
