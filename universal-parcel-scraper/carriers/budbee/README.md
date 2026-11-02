# Budbee

Budbee parcels use enabled universal providers. There is no dedicated adapter.

Budbee and Instabox both belong to Instabee Group but keep separate trackers. The Instabox
adapter reads Instabox notification links on `track.instabox.com`. Budbee's tracker on
`track.budbee.com` asks for the recipient's email address or phone number before it shows a
parcel.

## Numbers

Archived Budbee tracker addresses carry thirteen digits or twelve letters and digits. Both
layouts are printed by other carriers too, so no rule claims them.

## Links

The library reads the number from `track.budbee.com/{language}/{number}/verify`, from
`track.budbee.com/{number}` and from its `verifyTrackingId` parameter. None of these shows a
parcel without the recipient's verification, so there is no tracking-page template.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
