# Botswana Post

Botswana Post parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Botswana Post's letters, parcels and EMS items carry UPU S10 numbers ending in `BW`. Generic
postal detection handles these numbers, so no rule for Botswana Post claims them.

## Links

The track and trace page on `botswanapost.post` posts the number to the Post Global tracker at
`posttracking.botswanapost.co.bw/postglobal/vpo/Track.aspx`, which answers a posted form. An
archived lookup passed the number as `itemid` on that page, but the capture showed only the
empty form, so no address is known to open one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
