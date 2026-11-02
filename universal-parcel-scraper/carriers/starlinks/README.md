# Starlinks

Starlinks parcels use enabled universal providers. There is no dedicated adapter.

Starlinks is a Saudi logistics company with e-commerce delivery, B2B and freight divisions.

## Numbers

Archived lookups on its tracker show `SL` followed by ten digits and, in later ones, `S`
followed by ten digits. `starlinks-1` suggests Starlinks for the `SL` layout at low confidence,
since rules for Aramex Australia and New Zealand accept any two letters and ten digits. The `S`
layout matches GLS Italy's depot numbers, so no rule claims it.

## Links

The tracking form opens `consignee.starlinks-me.com/tracking/{number}`; older pages used
`www.starlinks-me.com/tracking?search={number}`. The library reads the number from either
address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
