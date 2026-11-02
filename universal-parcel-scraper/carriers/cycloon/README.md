# Cycloon

Cycloon parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Cycloon's tracker asks for a track and trace code and the recipient's postcode. Its example
code, and every code in archived lookups on its own tracker, is `FKS` followed by ten letters
and digits, which `cycloon-1` claims; no other carrier prints the prefix.

## Links

Archived lookups put the code in the path of `cycloon.eu/trackandtrace/`, followed by the
postcode as a second segment. The current tracker on `tracktrace.cycloon.eu` reads the code
from `tt` and the postcode from `pc`, or from the last two path segments. A lookup needs the
postcode, so no address opens a parcel from the code alone.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
