# Overseas Express

Overseas Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Overseas Express asks for the eight-digit parcel number. Its former tracker explained that the
whole barcode reads as three digits, three digits, the eight-digit number and two more digits,
and that only the eight digits are entered. Archived lookups on its trackers carry those eight
digits. Eight digits are shared with other carriers, so no rule claims them.

## Links

The header form on `www.overseas.hr` sends the number as `trackingid` to
`inet.overseas.hr/auth`. Archived lookups use `is.overseas.hr/tracking/?trackingid={number}`,
`is.overseas.hr/track-and-trace/{number}` and, on the former site,
`www.overseas.hr/Tracking/Package/{number}`. The newer pages fill the form by script, and no
address was seen to open a history, so the catalog has no parcel link.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
