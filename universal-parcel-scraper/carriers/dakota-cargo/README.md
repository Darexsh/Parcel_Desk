# Dakota Cargo

Dakota Cargo parcels use enabled universal providers. There is no dedicated adapter yet.

Dakota Cargo, run by PT Dakota Buana Semesta, carries cargo and parcels across Indonesia through
its branches and agents.

## Numbers

Its API page documents sixteen-character waybills: a three-digit branch code, the month and
year, `A` and a six-digit sequence. Sixteen characters also fit other carriers' numbers, so
`dakota-cargo-1` stays low confidence. Older all-digit waybills get no rule.

## Tracker

The site's form needs a session token and shows the full history only with the last digits of
the recipient's phone. The tracking request on its API page answers without a key.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
