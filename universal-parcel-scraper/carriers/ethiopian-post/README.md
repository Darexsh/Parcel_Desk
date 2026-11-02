# Ethiopian Postal Service

Ethiopian Postal Service parcels use enabled universal providers. There is no dedicated
adapter.

## Numbers

Ethiopost's international letters, parcels and EMS items carry UPU S10 numbers ending in `ET`.
Generic postal detection handles these numbers, so no rule for Ethiopost claims them. Its
domestic tracker takes the shipment ID printed on the booking receipt.

## Links

The domestic tracker at `domestictrack.ethio.post/PostGlobal/WebTrack/Track.aspx` posts the
number from its form and has no address for one item. For international items, Ethiopost's
pages link the UPU's Global Track and Trace.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
