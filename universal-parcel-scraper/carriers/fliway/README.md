# Fliway

Fliway parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Fliway is a New Zealand transport and logistics company. Its tracker takes consignment note
numbers and item tracking numbers. Archived lookups on the tracker show consignment numbers of
two letters and seven digits and of three letters and five digits. No rule claims them: short
letter-and-digit layouts like these are printed by many carriers, and two samples show no
shared prefix.

## Links

The tracker opens one consignment at `online.fliway.com/Public/Track/` followed by the number.
The home page form opens consignments at `/Public/Track/` and item tracking numbers at
`/Public/TrackItem/`, with the number in the `id` query parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
