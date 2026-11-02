# Super Parcel Track

Super Parcel Track parcels use enabled universal providers. There is no dedicated adapter.

Super Parcel Track is a Chinese parcel line shipping web shop orders from China to Europe, duties unpaid.
Its tracker is track-sp.com; Ant Parcel, at ant-parcel.com, is the same line under another name
and reads the same tracker.

## Numbers

No public page shows a Super Parcel Track number, so there is no rule.

## Why there is no adapter

Its tracker reads a number in three form posts carrying a per-page hash, without a session or CAPTCHA, and
answers an unknown number with not found. No public number is known to see a found reply.

## Links

The tracker opens numbers from its `tracking_num` parameter. Ant Parcel's page takes the number from
the same parameter or from its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
