# Costco Logistics

Costco Logistics parcels use enabled universal providers. There is no dedicated adapter yet.

Costco Logistics, formerly Innovel Solutions, delivers and installs Costco's big and bulky
orders in the United States. Its site is logistics.costco.com.

## Numbers

A tracking number is `1I`, the order date as eight digits and nine digits. Archived lookups and
scheduling pages of its site give six numbers, and its tracker answers one, so
`costco-logistics-1` has high confidence. Nine-digit orders and ten-digit work orders share
their layouts with many carriers and get no rule.

## Tracker

The tracking page asks a JSON interface that needs two fixed headers but no session. Its reply
holds the delivery address, which an adapter must leave out. Clocks have no zone and are local
to the delivering market.

## Links

The tracking page opens a number from its `id` parameter. Scheduling links carry an order key,
which the catalog never reads.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
