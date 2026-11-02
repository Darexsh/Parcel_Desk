# Azerpost

Azerpost parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Azerpost prints UPU S10 numbers ending in `AZ`; its tracking page gives a `CP` parcel as its
example, and archived lookups on its former tracker show items starting `SS`, `BB`, `RR`, `CP`
and other prefixes. Generic postal detection handles S10 numbers, so Azerpost has no rule of
its own.

## Links

The tracking page reads the number from its `package_id` parameter in Azerbaijani, English and
Russian, and the home page's search form builds that address. The former tracker opened one
parcel at `/az/tracking/{number}` or `/en/tracking/{number}`; those addresses now return an
error.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
